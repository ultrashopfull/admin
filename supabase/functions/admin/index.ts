import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const todayStr = () => new Date().toISOString().split("T")[0];
const DUMMY_HASH = "$2a$10$m4d90zFDefzGpJt1bkewhOoV9GzNFT8r1W2Mowli/DV8c.XMLhEf2";

const ipMemoryRateLimit = (globalThis as any).ipMemoryRateLimit || new Map();
(globalThis as any).ipMemoryRateLimit = ipMemoryRateLimit;

async function hashPassword(sb: any, password: string): Promise<string> {
  const { data, error } = await sb.rpc("hash_password", { p_password: String(password) });
  if (error || !data) throw new Error(error?.message || "No se pudo generar el hash.");
  return data as string;
}

type AuthInfo = {
  viaToken: boolean;
  staffId: string | null;
  username: string | null;
  role: "admin" | "seller";
  licenses: string[];
  staff: any | null;
};
type AuthResult = { error: Response } | { auth: AuthInfo };

const PRODUCT_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT", gemini: "Gemini", capcut: "CapCut", claude: "Claude",
  perplexity: "Perplexity", superprompt: "Superprompt", codex: "Codex",
};
function licenseKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}
function roleOf(value: unknown): "admin" | "seller" {
  return String(value || "").toLowerCase() === "admin" ? "admin" : "seller";
}
async function loadStaffMeta(sb: any, staffId: string): Promise<{ active?: boolean; licenses?: string[]; accountIds?: string[] }> {
  try {
    const { data, error } = await sb
      .from("ultrashop_panel_state")
      .select("staff_meta")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) throw new Error("No se pudo comprobar el acceso.");
    return data.staff_meta?.[String(staffId)] || {};
  } catch {
    throw new Error("No se pudo comprobar el acceso.");
  }
}
function sanitizeSnapshot(snapshot: any, auth: AuthInfo) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.state) throw new Error("Panel no disponible");
  const state = snapshot.state;
  const allStaff = Array.isArray(snapshot.staff) ? snapshot.staff : [];
  const me = allStaff.find((u: any) => String(u.id) === auth.staffId);
  const meta = state.staff_meta?.[String(auth.staffId)] || {};
  if (!auth.viaToken && (!me || meta.active === false)) throw new Error("Acceso no disponible");
  const admin = auth.viaToken || roleOf(me?.rol) === "admin";
  const numbers = new Map<string, number>();
  const allAccounts = (Array.isArray(snapshot.accounts) ? snapshot.accounts : []).map((a: any) => {
    const key = String(a.producto_id);
    const n = (numbers.get(key) || 0) + 1;
    numbers.set(key, n);
    return { ...a, panel_number: n };
  });
  allStaff.forEach((u: any) => {
    delete u.password;
    const staffMeta = state.staff_meta?.[String(u.id)] || {};
    if (staffMeta.deleted === true) delete u.password_text;
  });
  if (admin) return { ...snapshot, accounts: allAccounts };
  const licenses = new Set<string>(Array.isArray(meta.licenses) ? meta.licenses.map((x: any) => String(x).toLowerCase()) : []);
  const assigned = new Set<string>(snapshot.account_permissions_version === 1 && Array.isArray(meta.accountIds) ? meta.accountIds.map(String) : []);
  const catalog = state.catalog || {};
  const products = (Array.isArray(snapshot.products) ? snapshot.products : []).filter((p: any) => {
    const key = String(p.nombre).toLowerCase();
    return licenses.has(key) && !catalog[key]?.hidden;
  });
  const productKeys = new Map<string, string>(products.map((p: any) => [String(p.id), String(p.nombre).toLowerCase()]));
  const accounts = allAccounts.filter((a: any) => assigned.has(String(a.id)) && productKeys.has(String(a.producto_id)))
    .map((a: any) => { const { password, totp_seed, notas, ...safe } = a; return safe; });
  const accountProducts = new Map<string, string>(accounts.map((a: any) => [String(a.id), productKeys.get(String(a.producto_id))!]));
  const accountIds = new Set(accountProducts.keys());
  const visibleKeys = new Set(accountProducts.values());
  const visibleProducts = products.filter((p: any) => visibleKeys.has(String(p.nombre).toLowerCase()));
  const visibleCatalog: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(catalog)) if (visibleKeys.has(key)) visibleCatalog[key] = value;
  const seen = new Set<string>();
  const subscriptions = (Array.isArray(snapshot.subscriptions) ? snapshot.subscriptions : []).filter((sub: any) => {
    const key = String(sub.producto || '').toLowerCase();
    const pair = String(sub.cliente_id) + ':' + key;
    if (seen.has(pair)) return false;
    seen.add(pair); // El snapshot SQL ordena de más reciente a más antigua.
    if (sub.cuenta_asignada_id != null && sub.cuenta_maestra_id != null && String(sub.cuenta_asignada_id) !== String(sub.cuenta_maestra_id)) return false;
    return accountProducts.get(String(sub.cuenta_asignada_id ?? sub.cuenta_maestra_id)) === key;
  });
  const clientIds = new Set(subscriptions.map((s: any) => String(s.cliente_id)));
  const subscriptionIds = new Set(subscriptions.map((s: any) => String(s.id)));
  const clients = (Array.isArray(snapshot.clients) ? snapshot.clients : []).filter((c: any) => clientIds.has(String(c.id))).map((c: any) => {
    const safe = { ...c }; delete safe.password_hash;
    const keys = new Set(subscriptions.filter((sub: any) => String(sub.cliente_id) === String(c.id)).map((sub: any) => String(sub.producto).toLowerCase()));
    for (const key of Object.keys(safe)) {
      if (key.startsWith('revoke_nonce') || key.startsWith('migration_nonce') || key.startsWith('device_id') || key.startsWith('device_last_seen')) delete safe[key];
      if (key === 'device_label_gpt' && !keys.has('chatgpt') || key === 'device_label_gemini' && !keys.has('gemini') || key === 'device_label_capcut' && !keys.has('capcut')) delete safe[key];
    }
    if (!keys.has('codex')) delete safe.codex_enabled;
    // La contraseña del cliente puede servir también para otra suscripción.
    const outside = (snapshot.subscriptions || []).some((sub: any) => {
      if (String(sub.cliente_id) !== String(c.id)) return false;
      const key = String(sub.producto || '').toLowerCase();
      return (sub.cuenta_asignada_id != null && sub.cuenta_maestra_id != null && String(sub.cuenta_asignada_id) !== String(sub.cuenta_maestra_id)) ||
        accountProducts.get(String(sub.cuenta_asignada_id ?? sub.cuenta_maestra_id)) !== key;
    });
    if (outside) { delete safe.password_text; delete safe.device_label; }
    return safe;
  });
  const staff = [{ ...me }].map((u: any) => { delete u.password_text; return u; });
  const staffMeta: any = { [String(auth.staffId)]: { ...meta, accountIds: [...accountIds], licenses: [...visibleKeys] } };
  const masterMeta: any = {}, clientMeta: any = {};
  for (const id of accountIds) if (state.master_meta?.[id]) masterMeta[id] = state.master_meta[id];
  for (const id of subscriptionIds) if (state.client_meta?.[id]) clientMeta[id] = state.client_meta[id];
  const settings: any = {};
  for (const key of ['adminName','accessMessageTemplate','renewalMessageTemplate',`theme:${auth.staffId}`]) if (Object.hasOwn(state.settings || {}, key)) settings[key] = state.settings[key];
  return { version: snapshot.version, account_permissions_version: snapshot.account_permissions_version,
    state: { revision: state.revision, catalog: visibleCatalog, staff_meta: staffMeta, master_meta: masterMeta, client_meta: clientMeta, jobs: [], settings },
    products: visibleProducts, accounts, subscriptions, clients, staff };
}

async function checkAuth(req: Request, sb: any): Promise<AuthResult> {
  const got = (req.headers.get("authorization") || "").trim();
  if (!got) return { error: json({ success: false, mensaje: "No autorizado" }, 401) };

  const adminToken = (Deno.env.get("ADMIN_TOKEN") || "").trim();
  if (adminToken && (got === adminToken || got === `Bearer ${adminToken}`)) {
    return {
      auth: { viaToken: true, staffId: null, username: null, role: "admin", licenses: [], staff: null },
    };
  }

  const raw = got.startsWith("Bearer ") ? got.slice(7) : got;
  let decoded: string;
  try { decoded = atob(raw); } catch { return { error: json({ success: false, mensaje: "No autorizado" }, 401) }; }

  const colon = decoded.indexOf(":");
  if (colon < 1) return { error: json({ success: false, mensaje: "No autorizado" }, 401) };
  const username = decoded.slice(0, colon).trim();
  const password = decoded.slice(colon + 1);

  try {
    const { data: staffRow, error: selErr } = await sb
      .from("usuarios")
      .select("id, rol, username, password, nombre_completo")
      .eq("username", username)
      .abortSignal(AbortSignal.timeout(5000))
      .maybeSingle();

    if (selErr) return { error: json({ success: false, mensaje: "No autorizado" }, 401) };
    if (!staffRow) return { error: json({ success: false, mensaje: "No autorizado" }, 401) };

    const { data: pwOk } = await sb
      .rpc("verify_password", { p_password: password, p_hash: staffRow.password || DUMMY_HASH })
      .abortSignal(AbortSignal.timeout(5000));

    if (pwOk !== true) return { error: json({ success: false, mensaje: "No autorizado" }, 401) };

    const meta = await loadStaffMeta(sb, String(staffRow.id));
    if (meta.active === false) {
      return { error: json({ success: false, mensaje: "Tu acceso está suspendido. Contacta al administrador." }, 403) };
    }
    const role = roleOf(staffRow.rol);
    const licenses = Array.isArray(meta.licenses) ? meta.licenses.map(licenseKey) : [];
    return {
      auth: {
        viaToken: false,
        staffId: String(staffRow.id),
        username: staffRow.username,
        role,
        licenses,
        staff: staffRow,
      },
    };
  } catch {
    return { error: json({ success: false, mensaje: "No autorizado" }, 401) };
  }
}

function sellerDenied(message = "Se requiere rol admin"): Response {
  return json({ success: false, mensaje: message }, 403);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const _url = new URL(req.url);
  if (_url.searchParams.get("accion") === "ping") return json({ success: true, pong: Date.now() });

  const ip = req.headers.get("x-forwarded-for")?.split(',')[0]?.trim() || "unknown";
  const now = Date.now();
  let ipData = ipMemoryRateLimit.get(ip);
  if (!ipData || now > ipData.resetAt) ipData = { count: 0, resetAt: now + 60000 };
  ipData.count++;
  ipMemoryRateLimit.set(ip, ipData);
  if (ipData.count > 60) return json({ success: false, mensaje: "Demasiadas peticiones. Espera 1 minuto." }, 429);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const authResult = await checkAuth(req, sb);
  if ("error" in authResult) return authResult.error;
  const auth = authResult.auth;

  try {
    const accion = _url.searchParams.get("accion") || "";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (accion === "panel_sync") {
      const { data, error } = await sb.rpc("ultrashop_panel_snapshot");
      if (error) return json({ success: false, mensaje: error.message }, 500);
      return json({ success: true, snapshot: sanitizeSnapshot(data, auth) });
    }

    if (accion === "panel_action") {
      const { operation_id, expected_revision, command } = body || {};
      if (!operation_id || !command) return json({ success: false, mensaje: "Operación inválida" }, 400);
      const payload = body?.payload || {};
      if (typeof command !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return json({success:false,mensaje:'Operación inválida'},400);
      delete payload.password_text;
      if (command === "staff.delete") {
        if (!auth.viaToken && auth.role !== "admin") {
          return json({ success: false, mensaje: "Se requiere rol admin" }, 403);
        }
        const staffId = Number(payload.staffId);
        if (!Number.isSafeInteger(staffId) || staffId <= 0) {
          return json({ success: false, mensaje: "Identificador de usuario inválido" }, 400);
        }
        if (!auth.viaToken && Number(auth.staffId) === staffId) {
          return json({ success: false, mensaje: "No puedes eliminar tu propio usuario" }, 400);
        }
        const expectedRevision = Number(expected_revision);
        const { data: deleted, error: deleteError } = await sb.rpc("ultrashop_staff_soft_delete", {
          p_staff_id: staffId,
          p_actor_staff_id: auth.viaToken ? null : Number(auth.staffId),
          p_expected_revision: Number.isSafeInteger(expectedRevision) ? expectedRevision : null,
        });
        if (deleteError) {
          return json(
            { success: false, mensaje: deleteError.message, code: deleteError.code },
            deleteError.code === "40001" ? 409 : deleteError.code === "42501" ? 403 : 400,
          );
        }
        return json(deleted || { success: true, deleted: true, staffId: String(staffId) });
      }
      if (["client.create", "staff.save", "profile.save"].includes(command) && typeof payload.password === "string" && payload.password) {
        payload.password_text = payload.password;
        payload.password = await hashPassword(sb, payload.password);
      }
      const { data, error } = await sb.rpc("ultrashop_panel_action_scoped", {
        operation_id, expected_revision: expected_revision ?? 0, command, payload,
        actor_staff_id: auth.viaToken ? null : Number(auth.staffId),
      });
      if (error) return json({ success: false, mensaje: error.message, code: error.code }, error.code === "40001" ? 409 : error.code === "42501" ? 403 : 400);
      return json(data);
    }

    if (accion === "panel_operation") {
      const id = _url.searchParams.get("id");
      if (!id) return json({success:false,mensaje:'Identificador requerido'},400);
      let query = sb.from("ultrashop_panel_operations").select("result").eq("id", id);
      if (auth.role !== 'admin') query = query.eq('actor_staff_id', Number(auth.staffId));
      const { data, error } = await query.maybeSingle();
      if (error) return json({success:false,mensaje:'No se pudo consultar la operación'},400);
      return json({ success: true, result: data?.result || null });
    }

    if (accion === "staff_login") {
      // Basic auth has already validated the credentials. ADMIN_TOKEN callers
      // must still provide the target username and password in the body.
      let staff = auth.staff;
      if (!staff) {
        const { username, password } = body || {};
        const { data } = await sb.from("usuarios").select("*").eq("username", username).maybeSingle();
        const { data: pwOk } = await sb.rpc("verify_password", { p_password: password, p_hash: data?.password || DUMMY_HASH });
        if (!data || pwOk !== true) return json({ success: false, mensaje: "Credenciales inválidas" }, 401);
        staff = data;
      }
      const meta = await loadStaffMeta(sb, String(staff.id));
      if (meta.active === false) {
        return json({ success: false, mensaje: "Tu acceso está suspendido. Contacta al administrador." }, 403);
      }
      const role = roleOf(staff.rol);
      const licenses = Array.isArray(meta.licenses) ? meta.licenses.map(licenseKey) : [];
      const { data: stateRow } = await sb
        .from("ultrashop_panel_state")
        .select("catalog")
        .eq("id", true)
        .maybeSingle();
      const catalog = stateRow?.catalog && typeof stateRow.catalog === "object" ? stateRow.catalog : {};
      const licenseNames = role === "admin"
        ? Object.values(catalog).filter((v: any) => !v?.hidden).map((v: any) => v?.name).filter(Boolean)
        : licenses.map((key) => catalog[key]?.name || PRODUCT_NAMES[key] || key);
      return json({
        success: true,
        staff: {
          id: staff.id,
          username: staff.username,
          full_name: staff.nombre_completo,
          role,
          active: true,
          licenses,
          license_names: licenseNames,
          account_ids: Array.isArray(meta.accountIds) ? meta.accountIds.map(String) : [],
          password_text: staff.password_text || "",
        },
      });
    }

    const adminOnly = new Set([
      "listar_clientes", "crear_cliente", "editar_cliente", "resetear_password_cliente",
      "listar_enlaces_cliente", "eliminar_enlace", "eliminar_clientes",
      "extensions.upload", "extensions.delete",
    ]);
    // Toda la administración de actualizaciones queda reservada al administrador.
    if ((adminOnly.has(accion) || accion.startsWith("extensions.")) && auth.role !== "admin") return sellerDenied();

    if (accion === "listar_clientes") {
      const [{ data: clientes }, { data: sus }, { data: cuentas }, { data: productos }] = await Promise.all([
        sb.from("clientes").select("*").order("id", { ascending: false }),
        sb.from("suscripciones").select("*"),
        sb.from("cuentas_maestras").select("*"),
        sb.from("productos").select("*"),
      ]);
      const prodMap: any = {}; (productos || []).forEach((p: any) => (prodMap[p.id] = p.nombre));
      const cuentaMap: any = {}; (cuentas || []).forEach((c: any) => (cuentaMap[c.id] = c));
      const subByClient: any = {}; (sus || []).forEach((s: any) => (subByClient[s.cliente_id] ||= []).push(s));
      const today = todayStr();
      
      const list = (clientes || []).map((c: any) => {
        const mine = subByClient[c.id] || [];
        mine.sort((a: any, b: any) => Number(b.id) - Number(a.id));
        const prods = [...new Set(mine.map((s: any) => s.producto).filter(Boolean))];
        const actives = mine.filter((s: any) => s.estado === "activa" && s.fecha_vencimiento >= today);
        const maxD = actives.length ? Math.max(...actives.map((s: any) => Math.ceil((new Date(s.fecha_vencimiento).getTime() - new Date(today).getTime()) / 86400000))) : 0;
        const cm = mine.length && mine[0].cuenta_asignada_id ? cuentaMap[mine[0].cuenta_asignada_id] : null;
        
        return {
          id: c.id, usuario: c.usuario, 
          password: c.password_text || "", 
          nombre_completo: c.nombre_completo, email: c.email, telefono: c.telefono, 
          estado_cliente: c.estado, productos: prods.length ? prods : ["chatgpt"],
          dias_restantes: maxD, fecha_vencimiento: mine[0]?.fecha_vencimiento || null,
          dias_totales: mine[0]?.dias_totales || 30, cuenta_maestra_email: cm?.email || null,
          codex_enabled: c.codex_enabled === true,
        };
      });
      return json({ success: true, clientes: list });
    }

    if (accion === "crear_cliente") {
      const { usuario, password, email, telefono, nombre_completo, dias, productos } = body;
      const passwordHash = await hashPassword(sb, password);
      const { data: nc, error: e1 } = await sb.from("clientes").insert({
        usuario: String(usuario).trim(), password_hash: passwordHash,
        password_text: password, 
        email: email || null, telefono: telefono || null, nombre_completo: nombre_completo || null, estado: "activo",
      }).select("id").single();
      if (e1) return json({ success: false, mensaje: e1.message });
      return json({ success: true, cliente_id: nc.id });
    }

    if (accion === "editar_cliente") {
      const {
        cliente_id, usuario, telefono, producto,
        dias, fecha_vencimiento, dias_totales, codex_enabled
      } = body || {};

      if (!cliente_id) return json({ success: false, mensaje: "cliente_id requerido" }, 400);

      const upd: Record<string, unknown> = { actualizado_en: new Date().toISOString() };
      if (typeof usuario === "string" && usuario.trim()) upd.usuario = usuario.trim();
      if (typeof telefono === "string") upd.telefono = telefono.trim() || null;
      if (typeof codex_enabled === "boolean") upd.codex_enabled = codex_enabled;

      const { error: eUpd } = await sb.from("clientes").update(upd).eq("id", cliente_id);
      if (eUpd) return json({ success: false, mensaje: eUpd.message }, 400);

      if (producto) {
        const prod = String(producto).toLowerCase().trim();

        const { data: subs } = await sb
          .from("suscripciones")
          .select("id, fecha_vencimiento, dias_totales, estado")
          .eq("cliente_id", cliente_id)
          .ilike("producto", prod)
          .order("id", { ascending: false })
          .limit(1);

        const sub = subs?.[0];
        if (sub) {
          const subUpd: Record<string, unknown> = {};

          if (typeof fecha_vencimiento === "string" && fecha_vencimiento.trim()) {
            subUpd.fecha_vencimiento = fecha_vencimiento.trim();
          } else if (typeof dias === "number" && dias >= 0) {
            const nueva = new Date();
            nueva.setDate(nueva.getDate() + dias);
            subUpd.fecha_vencimiento = nueva.toISOString().split("T")[0];
          }

          if (typeof dias_totales === "number") subUpd.dias_totales = dias_totales;

          if (subUpd.fecha_vencimiento) {
            subUpd.estado = (subUpd.fecha_vencimiento as string) >= todayStr() ? "activa" : "vencida";
          }

          if (Object.keys(subUpd).length) {
            const { error: eSub } = await sb.from("suscripciones").update(subUpd).eq("id", sub.id);
            if (eSub) return json({ success: false, mensaje: eSub.message }, 400);
          }
        }
      }

      return json({ success: true });
    }

    if (accion === "resetear_password_cliente") {
      const { cliente_id } = body;
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
      let nueva = ""; for (let i = 0; i < 10; i++) nueva += chars[Math.floor(Math.random() * chars.length)];
      const passwordHash = await hashPassword(sb, nueva);
      
      const { error } = await sb.from("clientes").update({ 
        password_hash: passwordHash, 
        password_text: nueva, 
        actualizado_en: new Date().toISOString() 
      }).eq("id", cliente_id);
      
      if (error) return json({ success: false, mensaje: error.message });
      return json({ success: true, password: nueva });
    }

    // --- listar_enlaces_cliente (user_links) ---
    if (accion === "listar_enlaces_cliente") {
      const username = String(body?.username || _url.searchParams.get("username") || "").trim();
      let q = sb.from("user_links").select("*").order("created_at", { ascending: false });
      if (username) q = q.eq("username", username);
      else q = q.limit(100);
      const { data, error } = await q;
      if (error) return json({ success: false, mensaje: error.message });
      const all = data || [];
      if (all.length > 150) {
        const oldest = all.slice(150).map((l: any) => l.id);
        if (oldest.length) await sb.from("user_links").delete().in("id", oldest);
      }
      const kept = all.slice(0, 150);
      return json({ success: true, enlaces: kept.map((l: any) => ({
        id: l.id,
        username: l.username,
        device_id: l.device_id,
        tipo: l.tipo,
        resource_id: l.resource_id,
        resource_url: l.resource_url,
        title: l.title,
        created_at: l.created_at,
        updated_at: l.updated_at,
      })) });
    }

    // --- eliminar_enlace (user_links) ---
    if (accion === "eliminar_enlace") {
      const id = String(body?.id || _url.searchParams.get("id") || "").trim();
      if (!id) return json({ success: false, mensaje: "id requerido" });
      const { error } = await sb.from("user_links").delete().eq("id", id);
      if (error) return json({ success: false, mensaje: error.message });
      return json({ success: true });
    }

    // --- eliminar_clientes (borrado masivo) ---
    if (accion === "eliminar_clientes") {
      const ids = Array.isArray(body?.cliente_ids) ? body.cliente_ids : [];
      if (!ids.length) return json({ success: false, mensaje: "sin ids" });
      const { data: cls } = await sb.from("clientes").select("id, usuario").in("id", ids);
      const usernames = (cls || []).map((c: any) => c.usuario).filter(Boolean);
      await sb.from("suscripciones").delete().in("cliente_id", ids);
      if (usernames.length) await sb.from("user_links").delete().in("username", usernames);
      const { error } = await sb.from("clientes").delete().in("id", ids);
      if (error) return json({ success: false, mensaje: error.message });
      return json({ success: true, eliminados: ids.length });
    }

    /* ═══════════════════════════════════════════════════════════════════
       EXTENSIONES · bucket público "extensions"
       - Dos formatos por extensión: {key}.zip (PC) y {key}.crx (Móvil)
       - upsert: true → reemplaza sin necesidad de borrar
       ═══════════════════════════════════════════════════════════════════ */
    const EXT_BUCKET = "extensions";
    const EXT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB por archivo (≈6.7 MB base64)
    const EXT_VALID = new Set([
      "chatgpt", "gemini", "capcut", "claude",
      "perplexity", "superprompt", "codex",
    ]);
    const EXT_KINDS = new Set(["zip", "crx"]);
    const EXT_MIME: Record<string, string> = {
      zip: "application/zip",
      crx: "application/x-chrome-extension",
    };

    if (accion === "extensions.list") {
      const { data, error } = await sb.storage
        .from(EXT_BUCKET)
        .list("", { limit: 200, sortBy: { column: "updated_at", order: "desc" } });
      if (error) return json({ success: false, mensaje: error.message }, 500);

      const baseUrl = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${EXT_BUCKET}`;
      return json({
        success: true,
        files: (data || [])
          .filter((f: any) => /\.(zip|crx)$/i.test(String(f.name || "")))
          .map((f: any) => ({
            name: f.name,
            filename: f.name,
            size: f.metadata?.size ?? 0,
            updated_at: f.updated_at,
            mimetype: f.metadata?.mimetype,
            public_url: `${baseUrl}/${f.name}`,
          })),
      });
    }

    if (accion === "extensions.upload") {
      const { extension, kind, filename, data, size, contentType } = body as {
        extension?: string; kind?: string; filename?: string;
        data?: string; size?: number; contentType?: string;
      };

      if (!extension || !data) {
        return json({ success: false, mensaje: "Faltan datos: extension y data son obligatorios." }, 400);
      }
      const ext = String(kind || "").toLowerCase();
      if (!EXT_KINDS.has(ext)) {
        return json({ success: false, mensaje: `Formato no válido: "${ext}". Debe ser "zip" o "crx".` }, 400);
      }
      if (!EXT_VALID.has(String(extension).toLowerCase())) {
        return json({ success: false, mensaje: `Extensión no válida: ${extension}` }, 400);
      }
      if (typeof size === "number" && size > EXT_MAX_BYTES) {
        return json({
          success: false,
          mensaje: `El archivo supera el límite de ${(EXT_MAX_BYTES / 1024 / 1024).toFixed(1)} MB.`,
        }, 413);
      }

      let bytes: Uint8Array;
      try {
        const binary = atob(data);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } catch {
        return json({ success: false, mensaje: "Base64 inválido en 'data'." }, 400);
      }

      const path = `${String(extension).toLowerCase()}.${ext}`;
      const { error } = await sb.storage
        .from(EXT_BUCKET)
        .upload(path, bytes, {
          contentType: contentType || EXT_MIME[ext] || "application/octet-stream",
          upsert: true,
        });

      if (error) return json({ success: false, mensaje: error.message }, 500);

      const baseUrl = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${EXT_BUCKET}`;
      return json({
        success: true,
        file: {
          name: path,
          filename: filename || path,
          kind: ext,
          size: bytes.length,
          updated_at: new Date().toISOString(),
          public_url: `${baseUrl}/${path}`,
        },
      });
    }

    if (accion === "extensions.delete") {
      const { extension, kind } = body as { extension?: string; kind?: string };
      if (!extension) return json({ success: false, mensaje: "Falta 'extension'." }, 400);
      const ext = String(kind || "").toLowerCase();
      if (!EXT_KINDS.has(ext)) {
        return json({ success: false, mensaje: `Formato no válido: "${ext}".` }, 400);
      }

      const path = `${String(extension).toLowerCase()}.${ext}`;
      const { data: existing } = await sb.storage.from(EXT_BUCKET).list("", { limit: 500 });
      const exists = (existing || []).some((f: any) => f.name === path);
      if (!exists) return json({ success: true, removed: false, mensaje: "No existía." });

      const { error } = await sb.storage.from(EXT_BUCKET).remove([path]);
      if (error) return json({ success: false, mensaje: error.message }, 500);
      return json({ success: true, removed: true, kind: ext });
    }

    return json({ success: false, mensaje: `Acción no implementada: ${accion}` });
  } catch (err) {
    return json({ success: false, mensaje: String((err as Error)?.message || err) }, 500);
  }
});