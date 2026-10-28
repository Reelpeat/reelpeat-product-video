import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fields, resource, text } from './contracts.mjs';
import { fail, regularPath } from './local-files.mjs';

const MAX_BYTES = 8 * 1024 * 1024;

function publicURL(value) {
  text(value, 'url', 2048);
  let url;
  try { url = new URL(value); } catch { fail('INVALID_PRODUCT_URL', '需要公开HTTP(S)来源或图片链接。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    fail('INVALID_PRODUCT_URL', '来源或图片链接不能携带账号密码。');
}

// 中文注释：宿主只提供已授权的原图路径，客户端自己读取并上传，不让Agent拼接Base64。
export async function prepareProductImport(input, options, context) {
  fields(input, ['source_task_id', 'source_kind', 'title', 'description', 'specifications',
    'selected_variant', 'source_urls', 'images']);
  const capability = context.capability_details?.product_parse?.fallback_import;
  if (!context.capabilities?.includes('product_parse') || capability?.billing?.status !== 'not_billable' ||
      capability.billing.credits !== 0)
    fail('CAPABILITY_UNAVAILABLE', '服务尚未开放免费的商品资料导入，请保留资料并更新服务后续接。');
  resource(input.source_task_id); text(input.title, 'title', 1000);
  if (!capability.source_kinds?.includes(input.source_kind)) fail('INVALID_INPUT', '需要明确资料来自用户或浏览器。');
  for (const key of ['description', 'specifications', 'selected_variant']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > (key === 'selected_variant' ? 1000 : 10000)))
      fail('INVALID_INPUT', '商品补充字段格式或长度无效。');
  }
  const sources = input.source_urls || [];
  if (!Array.isArray(sources) || sources.length > 5 || (input.source_kind === 'browser_observed' && !sources.length))
    fail('SOURCE_EVIDENCE_REQUIRED', '浏览器资料需要实际查看的商品页链接，来源最多5条。');
  sources.forEach(publicURL);
  if (!Array.isArray(input.images) || !input.images.length || input.images.length > Math.min(9, capability.max_images || 9))
    fail('INVALID_IMAGES', '导入需要1～9张同商品原图。');
  const limit = Math.min(MAX_BYTES, capability.max_total_image_bytes || MAX_BYTES);
  const images = [];
  let total = 0;
  for (const image of input.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) fail('INVALID_IMAGES', '图片来源格式无效。');
    fields(image, ['url', 'file', 'data_base64']);
    if (Object.keys(image).length !== 1) fail('INVALID_IMAGES', '每张图只使用url、file或data_base64中的一个。');
    if (image.url !== undefined) {
      if (!capability.image_inputs?.includes('url')) fail('CAPABILITY_UNAVAILABLE', '当前服务未开放URL图片导入。');
      publicURL(image.url); images.push({ url: image.url }); continue;
    }
    if (!capability.image_inputs?.includes('data_base64')) fail('CAPABILITY_UNAVAILABLE', '当前服务未开放原图上传。');
    let data;
    if (image.file !== undefined) {
      text(image.file, 'file', 4096);
      const filename = path.resolve(options['work-dir'] || process.cwd(), image.file);
      const stat = await regularPath(filename);
      if (!stat.size || total + stat.size > limit) fail('IMAGE_TOO_LARGE', '导入图片总量不能超过服务限制（最多8MiB）。');
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.size !== stat.size) fail('UNSAFE_PATH', '图片文件在读取前发生变化。');
        data = await handle.readFile();
      } finally { await handle.close(); }
    } else {
      if (typeof image.data_base64 !== 'string' || image.data_base64.length > 4 * Math.ceil(limit / 3))
        fail('INVALID_IMAGES', '图片Base64编码无效或超长。');
      data = Buffer.from(image.data_base64, 'base64');
      // 中文注释：按规范编码往返校验，避免对大图片执行深层重复正则。
      if (data.toString('base64') !== image.data_base64) fail('INVALID_IMAGES', '图片Base64编码无效。');
    }
    total += data.length;
    if (!data.length || total > limit) fail('IMAGE_TOO_LARGE', '导入图片不能为空且总量最多8MiB。');
    images.push({ data_base64: data.toString('base64') });
  }
  return { ...input, source_urls: sources, images };
}
