/**
 * POST /api/xhs-card
 *
 * 抓取小红书笔记数据
 * 入参：{ url: "小红书链接" }
 * 出参：{ ok: true, note: { title, author, desc, images, imageCount, likedCount, commentCount, collectedCount, comments, url } }
 */

export default async function handler(req, res) {
  // 只接受 POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '仅支持 POST 请求' });
  }

  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ ok: false, error: '缺少 url 参数' });
  }

  // 设置 CORS 头（允许插件调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const note = await fetchXhsNote(url);
    return res.status(200).json({ ok: true, note });
  } catch (err) {
    console.error('抓取失败:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * 核心：抓取小红书笔记数据
 */
async function fetchXhsNote(url) {
  // 1. 标准化 URL
  let targetUrl = url.trim();

  // 处理短链 (xhslink.com) - fetch 默认跟随重定向
  // 补全协议头
  if (targetUrl.startsWith('//')) {
    targetUrl = 'https:' + targetUrl;
  } else if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  // 2. 用手机 UA 请求页面
  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://www.xiaohongshu.com/'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`页面请求失败 (HTTP ${response.status})`);
  }

  const html = await response.text();

  // 3. 提取 __INITIAL_STATE__
  const stateData = extractInitialState(html);
  if (!stateData) {
    throw new Error('无法解析小红书笔记数据，页面结构可能已变更');
  }

  // 4. 提取笔记数据（兼容两种路径）
  let noteData = null;

  if (stateData.noteData?.data?.noteData) {
    noteData = stateData.noteData.data.noteData;
  } else if (stateData.noteData?.normalNotePreloadData) {
    noteData = stateData.noteData.normalNotePreloadData;
  } else if (stateData.note?.noteData) {
    noteData = stateData.note.noteData;
  } else if (stateData.note) {
    noteData = stateData.note;
  }

  if (!noteData) {
    // 调试：输出 state 结构供排查
    const keys = Object.keys(stateData).join(', ');
    throw new Error(`无法找到笔记数据（可用字段: ${keys}）`);
  }

  // 5. 处理图片 URL
  const images = extractImages(noteData);

  // 6. 提取评论
  const comments = extractComments(noteData);

  // 7. 格式化互动数据
  const formatCount = (n) => {
    if (!n && n !== 0) return '0';
    const num = parseInt(n);
    if (isNaN(num)) return '0';
    if (num >= 10000) return (num / 10000).toFixed(1) + '万';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  };

  // 互动数据可能在 interactInfo 或直接顶层
  const interactInfo = noteData.interactInfo || {};

  return {
    title: noteData.title || noteData.noteCard?.title || '',
    author: noteData.user?.nickname || noteData.noteCard?.user?.nickname || '',
    authorAvatar: noteData.user?.avatar || noteData.noteCard?.user?.avatar || '',
    desc: noteData.desc || noteData.noteCard?.desc || '',
    images,
    imageCount: images.length,
    likedCount: formatCount(noteData.likedCount || interactInfo.likedCount),
    commentCount: formatCount(noteData.commentCount || interactInfo.commentCount),
    collectedCount: formatCount(noteData.collectedCount || interactInfo.collectedCount),
    shareCount: formatCount(noteData.shareCount || interactInfo.shareCount),
    comments,
    url: targetUrl
  };
}

/**
 * 从 HTML 中提取 __INITIAL_STATE__ JSON
 */
function extractInitialState(html) {
  // 方案1：window.__INITIAL_STATE__ = {...} 直接 JSON
  const regex1 = /<script>window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i;
  const match1 = html.match(regex1);

  if (!match1) {
    // 方案2：尝试其他格式
    const regex2 = /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*\)?\s*<\/script>/i;
    const match2 = html.match(regex2);
    if (!match2) return null;

    let str = match2[1].trim();
    return tryParseState(str);
  }

  let str = match1[1].trim();
  return tryParseState(str);
}

/**
 * 尝试解析 state JSON 字符串
 */
function tryParseState(str) {
  // 去掉末尾分号
  str = str.replace(/;\s*$/, '');

  // 处理 JSON.parse('...') 包裹的情况
  if (str.startsWith('JSON.parse(')) {
    str = str.replace(/^JSON\.parse\(/, '').replace(/\)\s*$/, '');
    // 去掉首尾引号
    const quote = str[0];
    if (quote === "'" || quote === '"') {
      str = str.slice(1, -1);
      // 反转义
      str = str.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
  }

  // 替换 unicode 转义
  str = str.replace(/\\u002F/g, '/');
  str = str.replace(/\\u2014/g, '—');
  str = str.replace(/\\u2018/g, "'");
  str = str.replace(/\\u2019/g, "'");
  str = str.replace(/\\u201c/g, '"');
  str = str.replace(/\\u201d/g, '"');
  str = str.replace(/\\u003C/g, '<');
  str = str.replace(/\\u003E/g, '>');
  str = str.replace(/\\u0026/g, '&');

  try {
    return JSON.parse(str);
  } catch (e) {
    // 如果解析失败，尝试修复常见的 JSON 问题
    // 某些情况下引号内的内容可能包含未转义的特殊字符
    try {
      // 尝试更宽松的解析
      return new Function('return ' + str)();
    } catch (e2) {
      console.error('JSON 解析失败:', e.message);
      return null;
    }
  }
}

/**
 * 从 noteData 中提取图片 URL 列表
 */
function extractImages(noteData) {
  const imageList = noteData.imageList || [];

  return imageList.map(img => {
    // 尝试多种图片 URL 字段
    let url = img.url || img.originalUrl || '';

    // 如果 url 为空，从 infoList 中取
    if (!url && img.infoList && img.infoList.length > 0) {
      // 取最大尺寸的图片
      const sorted = [...img.infoList].sort((a, b) => (b.width || 0) - (a.width || 0));
      url = sorted[0]?.url || '';
    }

    // 如果还没有，尝试 fileId
    if (!url && img.fileId) {
      url = `https://ci.xiaohongshu.com/${img.fileId}`;
    }

    // 处理转义
    url = url.replace(/\\u002F/g, '/');

    // 补全协议头
    if (url.startsWith('//')) {
      url = 'https:' + url;
    }

    return url;
  }).filter(url => url && url.startsWith('http'));
}

/**
 * 从 noteData 中提取评论列表
 */
function extractComments(noteData) {
  // 评论可能在 commentList 或 commentData 中
  let commentList = noteData.commentList || noteData.commentData || [];

  // 如果是对象而非数组
  if (!Array.isArray(commentList)) {
    commentList = commentList.comments || commentList.list || [];
  }

  return commentList.slice(0, 20).map(c => ({
    user: c.user?.nickname || c.userInfo?.nickname || '',
    userAvatar: c.user?.avatar || c.userInfo?.avatar || '',
    content: c.content || c.text || '',
    ipLocation: c.ipLocation || c.ip_label || '',
    likedCount: c.likedCount || c.likeCount || 0,
    time: c.createTime || c.time || ''
  }));
}
