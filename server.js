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
// 仍然保留这个，因为它对于 OAuth 流程是必要的
const redirectURL = process.env.PRODUCTION_URL
  ? `${process.env.PRODUCTION_URL}/auth/google/callback`
  : `http://localhost:${port}/auth/google/callback`;

// --- 中间件 ---
app.use(cors({
    origin: process.env.PRODUCTION_URL, // 只允许来自您的生产 URL 的请求
    credentials: true
}));
app.use(express.json());
// 简化：让 Express 自动服务 public 文件夹中的所有静态文件
app.use(express.static(path.join(__dirname, 'public'))); 
const upload = multer({ storage: multer.memoryStorage() });

// --- Cookie-Session 配置 ---
app.set('trust proxy', 1);
app.use(
  cookieSession({
    name: 'easyappointment-session',
    secret: process.env.SESSION_SECRET,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  })
);


// --- Google OAuth 2.0 配置 ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectURL
);

const scopes = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

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
    console.log('成功获取 Token (包含 Refresh Token) 并存入 Cookie Session');
    res.redirect('/?loginsuccess=true');
  } catch (error) {
    console.error('获取 Token 时出错:', error);
    res.status(500).send('授权失败');
  }
});

app.get('/api/check-auth', async (req, res) => {
    if (req.session && req.session.tokens) {
        try {
            if (req.session.tokens.refresh_token) {
                oauth2Client.setCredentials({
                    refresh_token: req.session.tokens.refresh_token
                });
                const { credentials } = await oauth2Client.refreshAccessToken();
                req.session.tokens = {
                    ...req.session.tokens,
                    ...credentials
                };
                 console.log('通过 Refresh Token 刷新 Access Token 成功');
                res.json({ loggedIn: true });
            } else {
                 oauth2Client.setCredentials(req.session.tokens);
                 const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
                 await calendar.settings.get({ setting: 'timezone' });
                 res.json({ loggedIn: true });
            }
        } catch (error) {
            console.log('Token 无效或已过期, 需要重新登录:', error.message);
            req.session = null;
            res.json({ loggedIn: false });
        }
    } else {
        res.json({ loggedIn: false });
    }
});


app.post('/api/create-event-from-image', upload.single('eventImage'), async (req, res) => {
  if (!req.session || !req.session.tokens) {
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
    const prompt = `从图片中提取日历事件信息。今天是 ${today}。
请先判断图片中的主要语言，然后根据该语言最常见的日期格式（例如，对西班牙语和多数欧洲语言使用 DD/MM/YYYY，对美式英语使用 MM/DD/YYYY）来解析日期。
将开始和结束时间格式化为不含时区信息的 ISO 8601 字符串（例如 '2025-09-10T12:20:00'）。
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

    console.log('正在获取用户日历的默认时区...');
    const settings = await calendar.settings.get({ setting: 'timezone' });
    const userTimezone = settings.data.value;
    console.log(`获取成功，用户时区为: ${userTimezone}`);
    
    let endDateTime;
    const startDate = new Date(parsedEvent.startDateTime); 

    if (parsedEvent.endDateTime === 'N/A' || !parsedEvent.endDateTime) {
        startDate.setHours(startDate.getHours() + 1);
        endDateTime = startDate.toISOString().slice(0, 19);
    } else {
        endDateTime = parsedEvent.endDateTime;
    }

    const event = {
      summary: parsedEvent.title,
      location: parsedEvent.location,
      start: { 
        dateTime: parsedEvent.startDateTime, 
        timeZone: userTimezone
      },
      end: { 
        dateTime: endDateTime, 
        timeZone: userTimezone
      },
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


// 移除自定义的 app.get('/') 路由，让 express.static 处理

// --- 导出 app 供 Vercel 使用 ---
module.exports = app;

