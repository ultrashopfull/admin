import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── PANEL COMPARTIDO (inlined desde _shared/panel.ts) ───────────────────────
type PanelClient = {
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => any;
};
type PanelClaims = {
  v: number; purpose: string; cliente_id: string | number; producto: string;
  iat: number; exp: number; auth: string; jti: string;
};
const PANEL_TTL = 8 * 60 * 60;
const PANEL_DUMMY_HASH = "$2a$10$m4d90zFDefzGpJt1bkewhOoV9GzNFT8r1W2Mowli/DV8c.XMLhEf2";
const panelEncoder = new TextEncoder();
const panelText = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const panelProduct = (value: unknown): string => panelText(value).toLowerCase();
const panelCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
class PanelError extends Error {
  constructor(public motivo: string, message: string, public status = 400) { super(message); }
}
function panelJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ modo: "panel", version_panel: 1, ...body }), { status, headers: panelCors });
}
function panelFailure(error: unknown): Response {
  if (error instanceof PanelError) return panelJson({ success: false, motivo: error.motivo, mensaje: error.message }, error.status);
  console.error("[panel] Error interno de consulta.");
  return panelJson({ success: false, motivo: "ERROR_SERVIDOR", mensaje: "No se pudo consultar tu licencia. Intenta de nuevo." }, 500);
}
function panelBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function panelBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  if (panelBase64(bytes) !== value) throw new Error("Non-canonical encoding");
  return bytes;
}
async function panelKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("PANEL_SESSION_SECRET") || "";
  if (secret.length < 32) throw new PanelError("PANEL_NO_CONFIGURADO", "El acceso de consulta todavía no está configurado. Contacta con soporte.", 503);
  return await crypto.subtle.importKey("raw", panelEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function panelSign(key: CryptoKey, value: string): Promise<string> {
  return panelBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, panelEncoder.encode(value))));
}
async function panelIssue(key: CryptoKey, cliente: any, producto: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: PanelClaims = {
    v: 1, purpose: "ultrashop-panel", cliente_id: cliente.id, producto,
    iat: now, exp: now + PANEL_TTL, jti: crypto.randomUUID(),
    auth: await panelSign(key, "panel-password-v1." + cliente.password_hash),
  };
  const payload = panelBase64(panelEncoder.encode(JSON.stringify(claims)));
  return payload + "." + await panelSign(key, "panel-token-v1." + payload);
}
async function panelSubscription(db: PanelClient, clienteId: string | number): Promise<any> {
  const { data, error, count } = await db.from("suscripciones")
    .select("id,cliente_id,producto,estado,fecha_vencimiento,dias_totales", { count: "exact" })
    .eq("cliente_id", clienteId).order("id", { ascending: false });
  if (error || !Array.isArray(data) || count !== data.length) throw new PanelError("ERROR_SERVIDOR", "No se pudo comprobar la afiliación completa de esta cuenta.", 500);
  if (!data.length) throw new PanelError("SIN_SUSCRIPCION", "No hay una suscripción asociada a esta cuenta.", 404);
  if (data.some(row => !panelProduct(row.producto))) throw new PanelError("SIN_PRODUCTO", "Hay una suscripción sin producto asignado. Contacta con soporte.", 409);
  const products = new Set(data.map(row => panelProduct(row.producto)));
  if (products.size !== 1) throw new PanelError("MULTIPLES_PRODUCTOS", "Esta cuenta tiene varios productos asociados. Contacta con soporte para separar las cuentas.", 409);
  return data[0];
}
function panelSnapshot(cliente: any, subscription: any): Record<string, unknown> {
  const expiry = panelText(subscription.fecha_vencimiento);
  const date = new Date(expiry + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== expiry) {
    throw new PanelError("FECHA_INVALIDA", "El vencimiento de esta cuenta necesita revisión. Contacta con soporte.", 409);
  }
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.max(0, Math.ceil((date.getTime() - today) / 86400000));
  const clientState = panelText(cliente.estado).toLowerCase();
  const subState = panelText(subscription.estado).toLowerCase();
  let state: string;
  if (["suspendido", "cancelado"].includes(clientState)) state = clientState;
  else if (["suspendida", "cancelada", "inactiva"].includes(subState)) state = subState;
  else if (days === 0 || subState === "vencida") state = "vencido";
  else if (subState === "activa" && ["activo", "vencido"].includes(clientState)) state = "activo";
  else state = clientState || subState || "sin confirmar";
  const active = state === "activo";
  return {
    success: true, activo: active, estado: state,
    cliente: { id: cliente.id, usuario: cliente.usuario, estado: state },
    suscripcion: {
      id: subscription.id, producto: panelProduct(subscription.producto),
      estado: state, fecha_vencimiento: expiry, dias_restantes: days,
      dias_totales: typeof subscription.dias_totales === "number" && Number.isFinite(subscription.dias_totales) && subscription.dias_totales > 0 ? subscription.dias_totales : null,
    },
    codex_enabled: active && cliente.codex_enabled === true,
  };
}
async function loginPanel(db: PanelClient, body: any): Promise<Response> {
  try {
    const usuario = panelText(body.usuario);
    if (!usuario || usuario.length > 254 || typeof body.password !== "string" || !body.password || body.password.length > 1024) {
      throw new PanelError("FALTAN_DATOS", "Escribe el usuario o correo de tu compra y la contraseña.");
    }
    const key = await panelKey();
    const { data: cliente, error } = await db.from("clientes")
      .select("id,usuario,password_hash,estado,codex_enabled").eq("usuario", usuario).maybeSingle();
    if (error) throw new PanelError("ERROR_SERVIDOR", "No se pudo consultar la cuenta.", 500);
    const { data: passwordOk, error: passwordError } = await db.rpc("verify_password", {
      p_password: body.password, p_hash: cliente?.password_hash || PANEL_DUMMY_HASH,
    });
    if (passwordError) throw new PanelError("ERROR_SERVIDOR", "No se pudo comprobar la contraseña.", 500);
    if (!cliente?.password_hash || passwordOk !== true) throw new PanelError("CREDENCIALES", "Usuario o contraseña incorrectos.", 401);
    const sub = await panelSubscription(db, cliente.id);
    const snapshot = panelSnapshot(cliente, sub);
    const token = await panelIssue(key, cliente, panelProduct(sub.producto));
    return panelJson({ ...snapshot, panel_token: token, session_expires_in: PANEL_TTL });
  } catch (error) { return panelFailure(error); }
}
// ─────────────────────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ═══════════════════════════════════════════════════════════════════
    // 🛡️ RATE LIMIT
    // ═══════════════════════════════════════════════════════════════════
    const body = await req.json();
    const ip = req.headers.get("x-forwarded-for")?.split(',')[0]?.trim() || "unknown";
    const usuarioRate = (body?.usuario || "").toLowerCase().trim();

    const supabaseLimit = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    try {
      const { data: ipLimit } = await supabaseLimit.rpc("rate_limit_check", {
        p_bucket: `login-ip:${ip}`,
        p_max: 20,
        p_window_seconds: 60,
      });

      if (ipLimit && ipLimit[0] && !ipLimit[0].allowed) {
        console.log(`[login] 🛑 IP RATE LIMITED: ${ip}`);
        return new Response(
          JSON.stringify({
            success: false,
            motivo: "RATE_LIMIT",
            mensaje: "Demasiados intentos. Espera 1 minuto e intenta de nuevo.",
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" },
          }
        );
      }
    } catch (e) {
      console.warn("[login] Rate limit RPC falló (ignorando):", (e as Error).message);
    }

    if (usuarioRate) {
      try {
        const { data: userLimit } = await supabaseLimit.rpc("rate_limit_check", {
          p_bucket: `login-user:${usuarioRate}`,
          p_max: 8,
          p_window_seconds: 60,
        });

        if (userLimit && userLimit[0] && !userLimit[0].allowed) {
          console.log(`[login] 🛑 USER RATE LIMITED: ${usuarioRate}`);
          return new Response(
            JSON.stringify({
              success: false,
              motivo: "RATE_LIMIT",
              mensaje: "Demasiados intentos para este usuario. Espera 1 minuto.",
            }),
            {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" },
            }
          );
        }
      } catch (e) {
        console.warn("[login] User rate limit RPC falló (ignorando):", (e as Error).message);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MODO PANEL
    // ═══════════════════════════════════════════════════════════════════
    if (body?.modo === "panel") {
      if (req.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders });
      const panelDb = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      return await loginPanel(panelDb, body);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LOGIN CLIENTE (extensión)
    // ═══════════════════════════════════════════════════════════════════
    const { usuario, password, device_id, device_mac, producto } = body;
    const prodInput = (producto || "").toLowerCase().trim();

    if (!usuario || !password) {
      return json({ success: false, motivo: "FALTAN_DATOS", mensaje: "Usuario y contraseña requeridos." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const DUMMY_HASH = "$2a$10$m4d90zFDefzGpJt1bkewhOoV9GzNFT8r1W2Mowli/DV8c.XMLhEf2";

    const { data: cliente, error: errCliente } = await supabase
      .from("clientes").select("*")
      .eq("usuario", usuario)
      .maybeSingle();

    if (errCliente) {
      console.error("[login] errCliente:", errCliente);
      return json({ success: false, motivo: "ERROR_SERVIDOR", mensaje: errCliente.message }, 500);
    }

    const { data: passwordOk, error: errPassword } = await supabase.rpc("verify_password", {
      p_password: password,
      p_hash: cliente?.password_hash || DUMMY_HASH,
    });

    if (errPassword) {
      console.error("[login] errPassword:", errPassword);
      return json({ success: false, motivo: "ERROR_SERVIDOR", mensaje: "No se pudo verificar la contraseña." }, 500);
    }

    if (!cliente || passwordOk !== true) {
      await supabase.from("logs_acceso").insert({
        accion: "login", resultado: "fallido",
        device_mac: device_mac || device_id || null,
        user_agent: req.headers.get("user-agent") || null,
      });
      return json({ success: false, motivo: "CREDENCIALES", mensaje: "Usuario o contraseña incorrectos." });
    }

    if (cliente.estado === "suspendido" || cliente.estado === "cancelado") {
      return json({ success: false, motivo: "SUSPENDIDO", mensaje: "Tu cuenta está suspendida." });
    }

    let susQuery = supabase
      .from("suscripciones").select("*")
      .eq("cliente_id", cliente.id)
      .in("estado", ["activa", "vencida"])
      .order("id", { ascending: false })
      .limit(1);
    if (prodInput) susQuery = susQuery.ilike("producto", prodInput);
    const { data: suscripcion, error: errSub } = await susQuery.maybeSingle();

    if (errSub) {
      console.error("[login] errSub:", errSub);
      return json({ success: false, motivo: "ERROR_SERVIDOR", mensaje: errSub.message }, 500);
    }

    if (!suscripcion) {
      return json({
        success: false, motivo: "SIN_SUSCRIPCION",
        mensaje: prodInput
          ? `No tienes una suscripción activa de ${prodInput}.`
          : "No tienes una suscripción activa.",
      });
    }

    const prod = (suscripcion.producto || prodInput || "chatgpt").toLowerCase().trim();

    // ═══════════════════════════════════════════════════════════════════
    // ✅ FIX v1.1: COL_MAP por producto (CapCut ya NO contamina ChatGPT)
    // ═══════════════════════════════════════════════════════════════════
    const COL_MAP: Record<string, {
      device_id: string;
      device_last_seen: string;
      device_label: string;
      revoke_nonce: string;
      migration_nonce: string;
    }> = {
      gemini: {
        device_id: "device_id_gemini",
        device_last_seen: "device_last_seen_gemini",
        device_label: "device_label_gemini",
        revoke_nonce: "revoke_nonce_gemini",
        migration_nonce: "migration_nonce_gemini",
      },
      capcut: {
        device_id: "device_id_capcut",
        device_last_seen: "device_last_seen_capcut",
        device_label: "device_label_capcut",
        revoke_nonce: "revoke_nonce_capcut",
        migration_nonce: "migration_nonce_capcut",
      },
    };

    const COL = COL_MAP[prod] || {
      device_id: "device_id_gpt",
      device_last_seen: "device_last_seen_gpt",
      device_label: "device_label_gpt",
      revoke_nonce: "revoke_nonce_gpt",
      migration_nonce: "migration_nonce_gpt",
    };

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const venc = new Date(suscripcion.fecha_vencimiento + "T00:00:00");
    const diasRestantes = Math.ceil((venc.getTime() - hoy.getTime()) / 86400000);

    if (diasRestantes <= 0) {
      await supabase.from("suscripciones").update({ estado: "vencida" }).eq("id", suscripcion.id);
      await supabase.from("clientes").update({ estado: "vencido" }).eq("id", cliente.id);
      await supabase.from("logs_acceso").insert({
        cliente_id: cliente.id, accion: "login", resultado: "bloqueado",
        device_mac: device_mac || device_id || null,
      });
      return json({
        success: false, motivo: "VENCIDO",
        mensaje: "Tu licencia ha vencido.", dias_restantes: 0,
      });
    }

    const { data: productoRow } = await supabase
      .from("productos").select("id").ilike("nombre", prod).maybeSingle();
    const productoId = productoRow?.id || null;

    if (!productoId) {
      return json({
        success: false, motivo: "SIN_PRODUCTO",
        mensaje: `El producto "${prod}" no existe en la tabla productos.`,
      });
    }

    let cuentaMaestra = null;

    if (suscripcion.cuenta_asignada_id) {
      const { data } = await supabase
        .from("cuentas_maestras").select("*")
        .eq("id", suscripcion.cuenta_asignada_id)
        .eq("producto_id", productoId)
        .in("estado", ["activa", "Disponible"])
        .maybeSingle();
      cuentaMaestra = data;
    }

    if (!cuentaMaestra) {
      const { data } = await supabase
        .from("cuentas_maestras").select("*")
        .eq("producto_id", productoId)
        .in("estado", ["activa", "Disponible"])
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      cuentaMaestra = data;

      if (cuentaMaestra) {
        await supabase.from("suscripciones").update({
          cuenta_asignada_id: cuentaMaestra.id,
          cuenta_maestra_id: cuentaMaestra.id,
        }).eq("id", suscripcion.id);
      }
    }

    if (!cuentaMaestra) {
      return json({
        success: false, motivo: "SIN_CUENTA",
        mensaje: `No hay cuentas de ${prod} disponibles.`,
      });
    }

    const deviceIdent = device_id || device_mac || null;
    const dispositivoAnterior = cliente[COL.device_id];
    const userAgent = req.headers.get("user-agent") || null;

    let etiqueta = "Desconocido";
    if (userAgent) {
      const ua = userAgent.toLowerCase();
      if (ua.includes("iphone")) etiqueta = "iPhone";
      else if (ua.includes("ipad")) etiqueta = "iPad";
      else if (ua.includes("ipod")) etiqueta = "iPod";
      else if (ua.includes("android")) {
        etiqueta = ua.includes("mobile") ? "Android (Móvil)" : "Android (Tablet)";
      }
      else if (ua.includes("windows")) etiqueta = "Windows";
      else if (ua.includes("macintosh") || ua.includes("mac os x")) etiqueta = "macOS";
      else if (ua.includes("cros")) etiqueta = "ChromeOS";
      else if (ua.includes("linux")) etiqueta = "Linux";
    }

    if (deviceIdent && dispositivoAnterior && dispositivoAnterior !== deviceIdent) {
      await supabase.from("logs_acceso").insert({
        cliente_id: cliente.id, accion: "desplazamiento",
        resultado: "otro_dispositivo",
        device_mac: deviceIdent, user_agent: userAgent,
      });
    }

    if (deviceIdent) {
      const upd: Record<string, unknown> = {};
      upd[COL.device_id] = deviceIdent;
      upd[COL.device_last_seen] = new Date().toISOString();
      upd[COL.device_label] = etiqueta;
      await supabase.from("clientes").update(upd).eq("id", cliente.id);
    }

    await supabase.from("logs_acceso").insert({
      cliente_id: cliente.id, accion: "login", resultado: "exitoso",
      device_mac: deviceIdent, user_agent: userAgent,
    });

    return json({
      success: true,
      cliente: {
        id: cliente.id, usuario: cliente.usuario,
        rol: cliente.rol, estado: cliente.estado,
      },
      suscripcion: {
        id: suscripcion.id, producto: suscripcion.producto,
        fecha_vencimiento: suscripcion.fecha_vencimiento,
        dias_restantes: diasRestantes,
        dias_totales: suscripcion.dias_totales,
      },
      credenciales: {
        email: cuentaMaestra.email,
        password: cuentaMaestra.password,
        totp_seed: cuentaMaestra.totp_seed || null,
        account_type: prod,
      },
      revoke_nonce: cliente[COL.revoke_nonce] || null,
      migration_nonce: cliente[COL.migration_nonce] || null,
    });
  } catch (err) {
    console.error("[login] catch:", err);
    return json({ success: false, motivo: "ERROR_SERVIDOR", mensaje: String(err) }, 500);
  }
});