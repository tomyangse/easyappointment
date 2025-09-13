const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const cookieSession = require('cookie-session');
require('dotenv').config();

// --- 应用程序设置 ---
const app = express();
const port = process.env.PORT || 3001;

// --- 环境变量检查 ---
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GEMINI_API_KEY || !process.env.SESSION_SECRET) {
    console.error("错误：缺少必要的环境变量。请检查您的 Vercel 配置。");
    if (!process.env.VERCEL) {
        process.exit(1);
    }
}

// --- 动态回调 URL ---
const redirectURL = process.env.PRODUCTION_URL
  ? `${process.env.PRODUCTION_URL}/auth/google/callback`
  : `http://localhost:${port}/auth/google/callback`;

// --- 中间件 ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- Cookie-Session 配置 ---
app.set('trust proxy', 1); // 在 Vercel 这样的代理环境下需要此设置
app.use(
  cookieSession({
    name: 'easyappointment-session',
    secret: process.env.SESSION_SECRET,
    httpOnly: true,
    secure: true, // 强制要求 HTTPS
    sameSite: 'lax', // 增强安全性
    maxAge: 24 * 60 * 60 * 1000
  })
);


// --- Google OAuth 2.0 配置 ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectURL
);

const scopes = ['https://www.googleapis.com/auth/calendar'];

// --- API 路由 ---

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    console.log('成功获取 Token 并存入 Cookie Session');
    res.redirect('/?loginsuccess=true');
  } catch (error) {
    console.error('获取 Token 时出错:', error);
    res.status(500).send('授权失败');
  }
});

app.post('/api/create-event-from-image', upload.single('eventImage'), async (req, res) => {
  // --- 新增的详细诊断日志 ---
  console.log('--- 开始处理 /api/create-event-from-image 请求 ---');
  console.log('请求头中的 Cookie:', req.headers.cookie || '未找到 Cookie');
  console.log('解析后的 Session 对象:', JSON.stringify(req.session, null, 2));
  // --- 诊断日志结束 ---

  if (!req.session || !req.session.tokens) {
    console.error('授权检查失败：Session 中未找到 tokens。');
    return res.status(401).json({ message: '用户未授权。请刷新页面并重新登录。' });
  }

  if (!req.file) {
    return res.status(400).json({ message: '未找到上传的图片。' });
  }

  try {
    const imageBase64 = req.file.buffer.toString('base64');
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;
    const today = new Date().toISOString().slice(0, 10);
    // --- 终极优化 V2：“侦探模式”指令 ---
    const prompt = `从图片中提取日历事件信息。今天是 ${today}。
你的任务分三步：
1.  **判断主要语言和地区**：分析图片中的所有文本，确定其主要语言。如果语言是英语，请根据地点、地址、电话号码、货币符号（如 £, $）或拼写（如 colour vs color）来判断是哪个地区（例如美国、英国、澳大利亚等）。
2.  **根据地区解析日期**：使用该地区最常见的日期格式来解析日期。例如：对美式英语，使用 MM/DD/YYYY；对英式英语、澳大利亚英语和多数欧洲语言，使用 DD/MM/YYYY。
3.  **设定备用规则**：如果无法确定具体地区，请优先使用 DD/MM/YYYY 格式，因为它在世界范围内更普遍。
最后，以 JSON 格式返回结果，包含字段："title", "startDateTime", "endDateTime", "location"。如果信息不完整，值设为 "N/A"。如果无法识别，返回 {"error": "未找到事件信息"}。请直接返回 JSON 对象，不要包含 markdown 格式。`;
    
    const payload = {
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: req.file.mimetype, data: imageBase64 } }] }],
      generationConfig: { "responseMimeType": "application/json" }
    };
    
    console.log('正在调用 Gemini API...');
    const geminiResponse = await axios.post(geminiApiUrl, payload);

    if (!geminiResponse.data.candidates || !geminiResponse.data.candidates[0].content.parts[0].text) {
        throw new Error("Gemini API 返回了无效的响应。");
    }
    const parsedEvent = JSON.parse(geminiResponse.data.candidates[0].content.parts[0].text);

    if (parsedEvent.error) { throw new Error(parsedEvent.error); }
    console.log('Gemini 识别结果:', parsedEvent);
    
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    let endDateTime;
    if (parsedEvent.endDateTime === 'N/A' || !parsedEvent.endDateTime) {
        const startDate = new Date(parsedEvent.startDateTime);
        startDate.setHours(startDate.getHours() + 1);
        endDateTime = startDate.toISOString();
        console.log(`未找到结束时间，已自动设置为: ${endDateTime}`);
    } else {
        endDateTime = parsedEvent.endDateTime;
    }

    const event = {
      summary: parsedEvent.title,
      location: parsedEvent.location,
      start: { dateTime: parsedEvent.startDateTime, timeZone: 'Asia/Shanghai' },
      end: { dateTime: endDateTime, timeZone: 'Asia/Shanghai' },
    };

    console.log('正在创建 Google 日历事件...');
    const calendarResponse = await calendar.events.insert({ calendarId: 'primary', resource: event });

    console.log('日历事件创建成功!');
    res.status(200).json({ message: '日历事件创建成功！', eventLink: calendarResponse.data.htmlLink });

  } catch (error) {
    console.error('处理过程中发生错误:', error.response ? error.response.data : error.message);
    res.status(500).json({ message: '服务器处理失败', error: error.message });
  }
});

// --- 根路由，服务于前端 ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 导出 app 供 Vercel 使用 ---
module.exports = app;




