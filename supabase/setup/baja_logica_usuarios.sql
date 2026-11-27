-- UltraShop: baja lógica de usuarios vendedores/administradores.
-- Conserva la fila de public.usuarios para no romper suscripciones ni otros
-- registros que referencian usuarios.id. Elimina el acceso y guarda la identidad
-- histórica en staff_meta para que el panel pueda mostrar la autoría.
-- Ejecutar una sola vez (el script es repetible) desde Supabase SQL Editor.

BEGIN;

CREATE OR REPLACE FUNCTION public.ultrashop_staff_soft_delete(
  p_staff_id bigint,
  p_actor_staff_id bigint DEFAULT NULL,
  p_expected_revision bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state public.ultrashop_panel_state%ROWTYPE;
  v_staff public.usuarios%ROWTYPE;
  v_meta jsonb;
  v_deleted_at timestamptz := now();
  v_deleted_name text;
  v_revision bigint;
  v_other_active_admins bigint;
BEGIN
  IF p_staff_id IS NULL OR p_staff_id <= 0 THEN
    RAISE EXCEPTION 'Identificador de usuario inválido.' USING ERRCODE = '22023';
  END IF;

  -- Mantener el mismo orden de bloqueo: primero el estado del panel y después
  -- el usuario. Así se serializan las bajas frente a las demás operaciones.
  SELECT * INTO v_state
  FROM public.ultrashop_panel_state
  WHERE id = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el estado del panel.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_staff
  FROM public.usuarios
  WHERE id = p_staff_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el usuario que deseas eliminar.' USING ERRCODE = 'P0002';
  END IF;

  v_meta := COALESCE(v_state.staff_meta -> (p_staff_id::text), '{}'::jsonb);

  -- Operación idempotente: si se perdió la respuesta de red, el reintento no
  -- vuelve a modificar registros ni genera una nueva baja.
  IF COALESCE((v_meta ->> 'deleted')::boolean, FALSE) THEN
    RETURN jsonb_build_object(
      'success', TRUE,
      'deleted', TRUE,
      'staffId', p_staff_id::text,
      'deletedName', COALESCE(v_meta ->> 'deletedName', v_staff.nombre_completo, v_staff.username),
      'revision', v_state.revision
    );
  END IF;

  IF p_expected_revision IS NOT NULL AND v_state.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'El panel cambió desde la última actualización. Actualiza e inténtalo de nuevo.'
      USING ERRCODE = '40001';
  END IF;

  IF LOWER(COALESCE(v_staff.rol, '')) = 'admin' THEN
    SELECT COUNT(*) INTO v_other_active_admins
    FROM public.usuarios AS other_staff
    WHERE other_staff.id <> p_staff_id
      AND LOWER(COALESCE(other_staff.rol, '')) = 'admin'
      AND COALESCE((v_state.staff_meta -> (other_staff.id::text) ->> 'active')::boolean, TRUE)
      AND NOT COALESCE((v_state.staff_meta -> (other_staff.id::text) ->> 'deleted')::boolean, FALSE);

    IF v_other_active_admins = 0 THEN
      RAISE EXCEPTION 'No puedes eliminar el último administrador activo.' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_deleted_name := COALESCE(
    NULLIF(BTRIM(v_staff.nombre_completo), ''),
    NULLIF(BTRIM(v_staff.username), ''),
    'Usuario'
  );

  v_meta := v_meta || jsonb_build_object(
    'active', FALSE,
    'deleted', TRUE,
    'deletedAt', to_char(v_deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletedBy', p_actor_staff_id,
    'deletedName', v_deleted_name,
    'deletedUsername', v_staff.username
  );

  -- La contraseña en texto plano ya no es necesaria para una cuenta archivada.
  UPDATE public.usuarios
  SET password_text = NULL
  WHERE id = p_staff_id;

  UPDATE public.ultrashop_panel_state
  SET staff_meta = jsonb_set(
        COALESCE(staff_meta, '{}'::jsonb),
        ARRAY[p_staff_id::text],
        v_meta,
        TRUE
      ),
      revision = COALESCE(revision, 0) + 1
  WHERE id = TRUE
  RETURNING revision INTO v_revision;

  -- No se elimina ni se reasigna ninguna fila de clientes, suscripciones,
  -- ventas u otras tablas. Tampoco se borra usuarios: la FK sigue válida.
  RETURN jsonb_build_object(
    'success', TRUE,
    'deleted', TRUE,
    'staffId', p_staff_id::text,
    'deletedName', v_deleted_name,
    'deletedAt', to_char(v_deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revision', v_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ultrashop_staff_soft_delete(bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ultrashop_staff_soft_delete(bigint, bigint, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ultrashop_staff_soft_delete(bigint, bigint, bigint) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
