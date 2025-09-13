// 引入所需的库
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// --- 应用程序设置 ---
const app = express();
// Vercel 会自动处理端口，但在本地开发时可能需要
const port = process.env.PORT || 3001;

// --- 环境变量检查 ---
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GEMINI_API_KEY) {
    console.error("错误：缺少必要的环境变量。请检查您的 .env 文件或 Vercel 配置。");
    // 在非 Vercel 环境下，正常退出
    if (!process.env.VERCEL) {
        process.exit(1);
    }
}


// --- 动态回调 URL ---
// 生产环境中，使用明确设置的 PRODUCTION_URL，否则使用 localhost
const redirectURL = process.env.PRODUCTION_URL
  ? `${process.env.PRODUCTION_URL}/auth/google/callback`
  : `http://localhost:${port}/auth/google/callback`;

// --- 中间件 ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // 托管 public 文件夹中的静态文件
const upload = multer({ storage: multer.memoryStorage() });

// --- Google OAuth 2.0 配置 ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectURL
);

const scopes = ['https://www.googleapis.com/auth/calendar'];
const userTokens = {}; // 简单内存存储

// --- API 路由 ---

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    userTokens['currentUser'] = tokens;
    console.log('成功获取 Token');
    // 授权成功后，重定向回应用的首页，并附带一个成功标志
    res.redirect('/?loginsuccess=true');
  } catch (error) {
    console.error('获取 Token 时出错:', error);
    res.status(500).send('授权失败');
  }
});

app.post('/api/create-event-from-image', upload.single('eventImage'), async (req, res) => {
  if (!userTokens['currentUser']) {
    return res.status(401).json({ message: '用户未授权。请刷新页面并重新登录。' });
  }

  if (!req.file) {
    return res.status(400).json({ message: '未找到上传的图片。' });
  }

  try {
    const imageBase64 = req.file.buffer.toString('base64');
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const geminiApiUrl = `https://generativelang.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `从图片中提取日历事件信息。今天是 ${today}。以 JSON 格式返回结果，包含字段："title", "startDateTime", "endDateTime", "location"。如果信息不完整，值设为 "N/A"。如果无法识别，返回 {"error": "未找到事件信息"}。请直接返回 JSON 对象，不要包含 markdown 格式。`;
    
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

    oauth2Client.setCredentials(userTokens['currentUser']);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const event = {
      summary: parsedEvent.title,
      location: parsedEvent.location,
      start: { dateTime: parsedEvent.startDateTime, timeZone: 'Asia/Shanghai' },
      end: { dateTime: parsedEvent.endDateTime, timeZone: 'Asia/Shanghai' },
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



