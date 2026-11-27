import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "X-Cache, Retry-After",
};

const HEARTBEAT_WRITE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min
const CACHE_TTL_MS = 45 * 1000;                       // 45 segundos
const IP_RATE_LIMIT = 40;                             // máx req/min por IP
const USER_RATE_LIMIT = 15;                           // máx req/min por usuario+device

// ✅ CACHÉ Y RATE LIMIT EN MEMORIA RAM (Cero Postgres en HITs)
const memoryCache = (globalThis as any).memoryCache || new Map();
const ipMemoryRateLimit = (globalThis as any).ipMemoryRateLimit || new Map();
(globalThis as any).memoryCache = memoryCache;
(globalThis as any).ipMemoryRateLimit = ipMemoryRateLimit;

// ✅ Función auxiliar para detectar el dispositivo desde el User-Agent
function detectDeviceLabel(ua: string): string {
  if (!ua) return "Desconocido";
  const u = ua.toLowerCase();
  
  if (u.includes("iphone")) return "iPhone";
  if (u.includes("ipad")) return "iPad";
  if (u.includes("ipod")) return "iPod";
  
  if (u.includes("android")) {
    return u.includes("mobile") ? "Android (Móvil)" : "Android (Tablet)";
  }
  
  if (u.includes("windows")) return "Windows";
  if (u.includes("macintosh") || u.includes("mac os x")) return "macOS";
  if (u.includes("cros")) return "ChromeOS";
  if (u.includes("linux")) return "Linux";
  
  return "Desconocido";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const t_start = performance.now();
  const log = (msg: string, data?: any) => {
    // Descomenta la siguiente línea si quieres ver todos los logs en Supabase
    // console.log(`[verificar-estado] ${msg} (${Math.round(performance.now() - t_start)}ms)`, data ? JSON.stringify(data) : "");
  };

  try {
    // ✅ PING: responde en <100ms sin tocar la BD ni bcrypt.
    // Mantiene el runtime caliente para evitar cold starts de 60s.
    const _url = new URL(req.url);
    if (_url.searchParams.get("accion") === "ping") {
      return new Response(JSON.stringify({ success: true, pong: Date.now() }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { usuario, device_id, client_migration_nonce, producto } = body;
    const prod = (producto || "chatgpt").toLowerCase().trim();
    const ip = req.headers.get("x-forwarded-for")?.split(',')[0]?.trim() || "unknown";
    const userAgent = req.headers.get("user-agent") || "";

    log(`📥 REQUEST`, { usuario, device_id, prod, ip });

    if (!usuario) {
      return new Response(
        JSON.stringify({ activo: false, motivo: "FALTA_USUARIO" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ═══════════════════════════════════════════════════════════════════
    // 🛑 CAPA 1: RATE LIMIT POR IP EN MEMORIA
    // ═══════════════════════════════════════════════════════════════════
    const now = Date.now();
    let ipData = ipMemoryRateLimit.get(ip);
    if (!ipData || now > ipData.resetAt) {
      ipData = { count: 0, resetAt: now + 60000 };
    }
    ipData.count++;
    ipMemoryRateLimit.set(ip, ipData);

    if (ipData.count > IP_RATE_LIMIT) {
      if (ipData.count === IP_RATE_LIMIT + 1) {
        log(`🛑 IP RATE LIMITED: ${ip}`);
      }
      return new Response(JSON.stringify({
        activo: true,
        motivo: "RATE_LIMIT",
        dias_restantes: 0,
        mensaje: "Demasiadas peticiones. Espera 1 minuto."
      }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" }
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // 🛑 CAPA 2: RATE LIMIT POR USUARIO EN MEMORIA
    // ═══════════════════════════════════════════════════════════════════
    const userBucketKey = `${usuario}:${device_id || 'no-device'}`;
    let userData = ipMemoryRateLimit.get(userBucketKey);
    if (!userData || now > userData.resetAt) {
      userData = { count: 0, resetAt: now + 60000 };
    }
    userData.count++;
    ipMemoryRateLimit.set(userBucketKey, userData);

    if (userData.count > USER_RATE_LIMIT) {
      if (userData.count === USER_RATE_LIMIT + 1) {
        log(`🛑 USER RATE LIMITED: ${usuario}`);
      }
      return new Response(JSON.stringify({
        activo: true,
        motivo: "RATE_LIMIT",
        dias_restantes: 0,
        mensaje: "Espera un momento."
      }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" }
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // 🚀 CAPA 3: CACHÉ EN MEMORIA RAM
    // ═══════════════════════════════════════════════════════════════════
    const cacheKey = `v1:${usuario}:${prod}:${client_migration_nonce || 'null'}:${device_id || 'null'}`;
    log(`🔑 Cache Key: ${cacheKey}`);

    const memCached = memoryCache.get(cacheKey);
    if (memCached && new Date(memCached.expires_at) > new Date()) {
      log(`⚡ Memoria RAM HIT — respondiendo en ~30ms`);
      return new Response(JSON.stringify(memCached.resultado), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // 📦 CAPA 4: CACHÉ EN POSTGRES (Si la memoria está vacía)
    // ═══════════════════════════════════════════════════════════════════
    try {
      const { data: dbCached, error: cacheErr } = await supabase
        .from("verificar_estado_cache")
        .select("resultado, expires_at")
        .eq("cache_key", cacheKey)
        .maybeSingle();

      if (!cacheErr && dbCached && new Date(dbCached.expires_at) > new Date()) {
        log(`📦 Postgres Cache HIT`);
        memoryCache.set(cacheKey, dbCached);
        return new Response(JSON.stringify(dbCached.resultado), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" },
        });
      }
    } catch (e) {
      log(`⚠️ Postgres cache read error (ignorando)`, (e as Error).message);
    }

    // ═══════════════════════════════════════════════════════════════════
    // 💾 CAPA 5: QUERY REAL A POSTGRES
    // ═══════════════════════════════════════════════════════════════════
    log(`💾 Consultando Postgres...`);

    const COL = prod === "gemini" ? {
      device_id: "device_id_gemini",
      device_last_seen: "device_last_seen_gemini",
      device_label: "device_label_gemini",
      revoke_nonce: "revoke_nonce_gemini",
      migration_nonce: "migration_nonce_gemini",
    } : {
      device_id: "device_id_gpt",
      device_last_seen: "device_last_seen_gpt",
      device_label: "device_label_gpt",
      revoke_nonce: "revoke_nonce_gpt",
      migration_nonce: "migration_nonce_gpt",
    };

    const { data: cliente, error: cliErr } = await supabase
      .from("clientes")
      .select("*")
      .eq("usuario", usuario)
      .maybeSingle();

    if (cliErr) {
      log(`❌ Postgres error clientes: ${cliErr.message}`);
      return new Response(JSON.stringify({
        activo: true, motivo: "ERROR_TEMPORAL", dias_restantes: 0,
        mensaje: "Servicio temporalmente no disponible."
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!cliente) {
      const result = { activo: false, motivo: "NO_EXISTE" };
      await supabase.from("verificar_estado_cache").upsert({
        cache_key: cacheKey, resultado: result, expires_at: new Date(Date.now() + 60000).toISOString(),
      });
      memoryCache.set(cacheKey, { resultado: result, expires_at: new Date(Date.now() + 60000).toISOString() });
      log(`❌ Cliente NO_EXISTE`);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    log(`✓ Cliente encontrado: ${cliente.id} (estado: ${cliente.estado})`);

    const revoke_nonce = cliente[COL.revoke_nonce] || null;
    const migration_nonce = cliente[COL.migration_nonce] || null;
    const migracionPendiente = !!(migration_nonce && client_migration_nonce !== migration_nonce);
    let assignedEmail: string | null = null;
    let assignedPassword: string | null = null;
    let assignedSeed: string | null = null;

    // ── SUSPENSIÓN / CANCELACIÓN ──
    if (cliente.estado === "suspendido" || cliente.estado === "cancelado") {
      const result = {
        activo: false, motivo: "SUSPENDIDO", mensaje: "Cuenta suspendida.",
        revoke_nonce, migration_nonce: migracionPendiente ? migration_nonce : null,
      };
      await supabase.from("verificar_estado_cache").upsert({
        cache_key: cacheKey, resultado: result, expires_at: new Date(Date.now() + 30000).toISOString(),
      });
      memoryCache.set(cacheKey, { resultado: result, expires_at: new Date(Date.now() + 30000).toISOString() });
      log(`⛔ SUSPENDIDO`);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── OTRO DISPOSITIVO ──
    const deviceAnterior = cliente[COL.device_id];
    if (device_id && deviceAnterior && deviceAnterior !== device_id) {
      const result = {
        activo: false, motivo: "OTRO_DISPOSITIVO",
        mensaje: "Tu cuenta se inició en otro dispositivo.",
        device_label: cliente[COL.device_label] || null,
        revoke_nonce, migration_nonce: migracionPendiente ? migration_nonce : null,
      };
      await supabase.from("verificar_estado_cache").upsert({
        cache_key: cacheKey, resultado: result, expires_at: new Date(Date.now() + 30000).toISOString(),
      });
      memoryCache.set(cacheKey, { resultado: result, expires_at: new Date(Date.now() + 30000).toISOString() });
      log(`⛔ OTRO_DISPOSITIVO`);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTUALIZAR ÚLTIMA CONEXIÓN Y DETECTAR DISPOSITIVO ──
    if (device_id) {
      const lastSeen = cliente[COL.device_last_seen]
        ? new Date(cliente[COL.device_last_seen]).getTime()
        : 0;

      if (Date.now() - lastSeen > HEARTBEAT_WRITE_THRESHOLD_MS) {
        const upd: Record<string, unknown> = {};
        upd[COL.device_last_seen] = new Date().toISOString();

        const nuevoLabel = detectDeviceLabel(userAgent);
        // Solo actualizar si el label cambió (evita escrituras innecesarias)
        if (nuevoLabel !== cliente[COL.device_label]) {
          upd[COL.device_label] = nuevoLabel;
          log(`📱 Nuevo dispositivo detectado: ${nuevoLabel}`);
        }

        await supabase.from("clientes").update(upd).eq("id", cliente.id);
        log(`✓ device_last_seen actualizado`);
      }
    }

    // ── SUSCRIPCIÓN ──
    const { data: suscripcion, error: errSub } = await supabase
      .from("suscripciones")
      .select("*")
      .eq("cliente_id", cliente.id)
      .ilike("producto", prod)
      .in("estado", ["activa", "vencida"])
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (errSub) {
      log(`❌ Postgres error suscripciones: ${errSub.message}`);
      return new Response(JSON.stringify({
        activo: true, motivo: "ERROR_TEMPORAL", dias_restantes: 0,
        mensaje: "Servicio temporalmente no disponible."
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!suscripcion) {
      const result = {
        activo: false, motivo: "SIN_SUSCRIPCION",
        mensaje: `No tienes suscripción activa de ${prod}.`,
        revoke_nonce, migration_nonce: migracionPendiente ? migration_nonce : null,
      };
      await supabase.from("verificar_estado_cache").upsert({
        cache_key: cacheKey, resultado: result, expires_at: new Date(Date.now() + 60000).toISOString(),
      });
      memoryCache.set(cacheKey, { resultado: result, expires_at: new Date(Date.now() + 60000).toISOString() });
      log(`⛔ SIN_SUSCRIPCION`);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    log(`✓ Suscripción: ${suscripcion.id} (vence: ${suscripcion.fecha_vencimiento})`);

    // ── MIGRACIÓN: LEER DATOS DE NUEVA CUENTA ──
    if (migracionPendiente) {
      const masterId = suscripcion.cuenta_maestra_id || suscripcion.cuenta_asignada_id;
      if (masterId) {
        const { data: master } = await supabase
          .from("cuentas_maestras")
          .select("email,password,totp_seed")
          .eq("id", masterId)
          .maybeSingle();
        if (master) {
          assignedEmail = master.email || null;
          assignedPassword = master.password || null;
          assignedSeed = master.totp_seed || null;
          log(`🔄 MIGRACIÓN: datos extraídos`);
        }
      }
    }

    // ── DÍAS RESTANTES ──
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const venc = new Date(suscripcion.fecha_vencimiento + "T00:00:00");
    const diasRestantes = Math.ceil((venc.getTime() - hoy.getTime()) / 86400000);

    if (diasRestantes <= 0) {
      const result = {
        activo: false, motivo: "VENCIDO", dias_restantes: 0,
        mensaje: "Tu licencia ha vencido.",
        revoke_nonce, migration_nonce: migracionPendiente ? migration_nonce : null,
        assigned_email: assignedEmail, assigned_password: assignedPassword, totp_seed: assignedSeed,
      };
      await supabase.from("verificar_estado_cache").upsert({
        cache_key: cacheKey, resultado: result, expires_at: new Date(Date.now() + 30000).toISOString(),
      });
      memoryCache.set(cacheKey, { resultado: result, expires_at: new Date(Date.now() + 30000).toISOString() });
      log(`⛔ VENCIDO`);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ✅ ACTIVO ──
    const finalResult = {
      activo: true,
      dias_restantes: diasRestantes,
      estado: cliente.estado,
      fecha_vencimiento: suscripcion.fecha_vencimiento,
      producto: suscripcion.producto,
      revoke_nonce,
      migration_nonce: migracionPendiente ? migration_nonce : null,
      assigned_email: assignedEmail,
      assigned_password: assignedPassword,
      totp_seed: assignedSeed,
      codex_enabled: !!cliente.codex_enabled,
    };

    const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();

    // Guardar en ambas capas
    await supabase.from("verificar_estado_cache").upsert({
      cache_key: cacheKey,
      resultado: finalResult,
      expires_at: expiresAt
    });
    memoryCache.set(cacheKey, { resultado: finalResult, expires_at: expiresAt });

    log(`✅ ACTIVO devuelto (${diasRestantes} días)`);
    return new Response(JSON.stringify(finalResult), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "MISS",
      },
    });
  } catch (err) {
    console.error("[verificar-estado] 💥 CATCH:", err);
    // Circuit breaker: si algo falla, NO bloquear al cliente
    return new Response(JSON.stringify({
      activo: true,
      motivo: "ERROR_TEMPORAL",
      dias_restantes: 0,
      mensaje: "Servicio temporalmente no disponible.",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});