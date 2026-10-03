INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at
)
VALUES (
  'temu-product-images',
  'TEMU 商品图片',
  true,
  31457280,
  ARRAY['image/jpeg', 'image/png', 'image/webp'],
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.temu_upload_batches (
  id text PRIMARY KEY,
  manifest_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'created',
  product_count integer NOT NULL CHECK (product_count > 0),
  expected_count integer NOT NULL CHECK (expected_count = product_count * 6),
  uploaded_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  store_id text,
  product_template_id text,
  sku_template_id text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.temu_upload_items (
  batch_id text NOT NULL REFERENCES public.temu_upload_batches(id) ON DELETE CASCADE,
  product_index integer NOT NULL CHECK (product_index > 0),
  image_position integer NOT NULL CHECK (image_position BETWEEN 1 AND 6),
  original_name text NOT NULL,
  object_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL,
  storage_status text NOT NULL DEFAULT 'pending',
  storage_etag text,
  erp_status text NOT NULL DEFAULT 'pending',
  erp_image_url text,
  erp_response jsonb,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, product_index, image_position),
  UNIQUE (batch_id, object_key)
);

-- Numbered slots are the identity. Different slots may intentionally contain
-- identical image bytes, so remove the constraint from an earlier deployment.
ALTER TABLE public.temu_upload_items
  DROP CONSTRAINT IF EXISTS temu_upload_items_batch_id_sha256_key;

CREATE INDEX IF NOT EXISTS temu_upload_items_batch_status_idx
  ON public.temu_upload_items(batch_id, storage_status, erp_status);

ALTER TABLE public.temu_upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temu_upload_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.temu_upload_batches FROM anon, authenticated;
REVOKE ALL ON public.temu_upload_items FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.temu_finalize_upload_batch(p_batch_id text)
RETURNS TABLE (
  expected_count integer,
  stored_count integer,
  matched_count integer,
  failed_count integer,
  complete boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  v_expected integer;
  v_stored integer;
  v_matched integer;
BEGIN
  SELECT b.expected_count INTO v_expected
  FROM public.temu_upload_batches b
  WHERE b.id = p_batch_id
  FOR UPDATE;

  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'batch not found';
  END IF;

  UPDATE public.temu_upload_items
  SET
    storage_status = 'pending',
    storage_etag = NULL,
    error_message = '云存储中未找到文件',
    updated_at = now()
  WHERE batch_id = p_batch_id;

  UPDATE public.temu_upload_items i
  SET
    storage_status = CASE
      WHEN COALESCE((o.metadata->>'size')::bigint, -1) <> i.size_bytes THEN 'mismatch'
      WHEN COALESCE(o.user_metadata->>'sha256', '') <> i.sha256 THEN 'mismatch'
      ELSE 'uploaded'
    END,
    storage_etag = COALESCE(o.metadata->>'eTag', o.metadata->>'etag'),
    error_message = CASE
      WHEN COALESCE((o.metadata->>'size')::bigint, -1) <> i.size_bytes THEN '文件大小不一致'
      WHEN COALESCE(o.user_metadata->>'sha256', '') <> i.sha256 THEN 'SHA-256 不一致'
      ELSE NULL
    END,
    updated_at = now()
  FROM storage.objects o
  WHERE i.batch_id = p_batch_id
    AND o.bucket_id = 'temu-product-images'
    AND o.name = i.object_key;

  SELECT
    count(*) FILTER (WHERE i.storage_status <> 'pending'),
    count(*) FILTER (WHERE i.storage_status = 'uploaded')
  INTO v_stored, v_matched
  FROM public.temu_upload_items i
  WHERE i.batch_id = p_batch_id;

  UPDATE public.temu_upload_batches b
  SET
    uploaded_count = v_matched,
    failed_count = v_expected - v_matched,
    status = CASE WHEN v_matched = v_expected THEN 'uploaded' ELSE 'uploading' END,
    error_message = CASE WHEN v_matched = v_expected THEN NULL ELSE '仍有图片未上传或校验不一致' END,
    updated_at = now()
  WHERE b.id = p_batch_id;

  RETURN QUERY SELECT
    v_expected,
    v_stored,
    v_matched,
    v_expected - v_matched,
    v_matched = v_expected;
END;
$$;

REVOKE ALL ON FUNCTION public.temu_finalize_upload_batch(text) FROM PUBLIC;

GRANT SELECT ON storage.buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON storage.objects TO anon, authenticated;

DROP POLICY IF EXISTS temu_images_public_read ON storage.objects;
CREATE POLICY temu_images_public_read
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'temu-product-images');

DROP POLICY IF EXISTS temu_images_public_insert ON storage.objects;
CREATE POLICY temu_images_public_insert
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'temu-product-images');

DROP POLICY IF EXISTS temu_images_public_update ON storage.objects;
CREATE POLICY temu_images_public_update
  ON storage.objects FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'temu-product-images')
  WITH CHECK (bucket_id = 'temu-product-images');
