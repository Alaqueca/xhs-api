/**
 * POST /api/xhs-images
 *
 * 下载小红书图片并转 base64
 * 入参：{ urls: ["图片URL1", "图片URL2", ...] }
 * 出参：{ ok: true, images: [{ url, base64, mime }] }
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '仅支持 POST 请求' });
  }

  const { urls } = req.body || {};

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ ok: false, error: '缺少 urls 参数或数组为空' });
  }

  // 最多同时处理 9 张图
  const limitedUrls = urls.slice(0, 9);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const results = await Promise.allSettled(
      limitedUrls.map(async (url) => {
        try {
          const imageData = await downloadImage(url);
          return { url, ...imageData };
        } catch (err) {
          return { url, error: err.message };
        }
      })
    );

    const images = results.map(r => {
      if (r.status === 'fulfilled') {
        return r.value;
      }
      return { url: r.reason?.url || 'unknown', error: r.reason?.message || '下载失败' };
    });

    return res.status(200).json({ ok: true, images });
  } catch (err) {
    console.error('图片下载失败:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * 下载单张图片并转 base64
 */
async function downloadImage(url) {
  // 标准化 URL
  let targetUrl = url;
  if (targetUrl.startsWith('//')) {
    targetUrl = 'https:' + targetUrl;
  }

  // 用服务端 fetch 绕过 CDN 防盗链
  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://www.xiaohongshu.com/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  });

  if (!response.ok) {
    throw new Error(`图片下载失败 (HTTP ${response.status})`);
  }

  // 获取 Content-Type
  const contentType = response.headers.get('content-type') || 'image/jpeg';

  // 读取为 ArrayBuffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 转 base64
  const base64 = buffer.toString('base64');

  return {
    base64: `data:${contentType};base64,${base64}`,
    mime: contentType,
    size: buffer.length
  };
}
