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
app.use(cors({
    origin: process.env.PRODUCTION_URL || 'http://localhost:3001',
    credentials: true
}));
app.use(express.json());
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
    // --- 图片处理指令 ---
    const prompt = `从图片中提取日历事件信息。今天是 ${today}。
你的任务分五步：
1.  **总结事件标题**：根据图片内容，生成一个简洁、概括性的事件标题（例如“与张三的会议”或“牙医预约”）。
2.  **判断主要语言和地区**：分析图片中的所有文本，确定其主要语言和地理位置。
3.  **根据地区解析日期**：使用该地区最常见的日期格式来解析日期。例如：对美式英语，使用 MM/DD/YYYY；对英式英语、澳大利亚英语和多数欧洲语言（如西班牙语），使用 DD/MM/YYYY。
4.  **提取联系方式和备注**：识别图片中的联系人姓名、电话号码、邮箱或任何其他备注信息。
5.  **格式化输出**：以 JSON 格式返回结果，包含字段："title", "startDateTime", "endDateTime", "location", "description"。将步骤4中提取的联系方式和备注整理后放入 "description" 字段。如果信息不完整，值设为 "N/A"。如果无法识别，返回 {"error": "未找到事件信息"}。请直接返回 JSON 对象，不要包含 markdown 格式。`;
    
    const payload = {
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: req.file.mimetype, data: imageBase64 } }] }],
      generationConfig: { "responseMimeType": "application/json" }
    };
    
    console.log('正在调用 Gemini API 处理图片...');
    const geminiResponse = await axios.post(geminiApiUrl, payload);
    const parsedEvent = JSON.parse(geminiResponse.data.candidates[0].content.parts[0].text);
    if (parsedEvent.error) { throw new Error(parsedEvent.error); }
    
    await createCalendarEvent(req, res, parsedEvent);

  } catch (error) {
    console.error('处理图片过程中发生错误:', error.response ? error.response.data : error.message);
    res.status(500).json({ message: '服务器处理图片失败', error: error.message });
  }
});

// --- 新增：处理语音输入的 API 接口 ---
app.post('/api/create-event-from-voice', upload.single('eventAudio'), async (req, res) => {
    if (!req.session || !req.session.tokens) {
        return res.status(401).json({ message: '用户未授权。请刷新页面并重新登录。' });
    }

    if (!req.file) {
        return res.status(400).json({ message: '未找到上传的语音。' });
    }

    try {
        const audioBase64 = req.file.buffer.toString('base64');
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;
        const today = new Date().toISOString().slice(0, 10);
        // --- 语音处理专属指令 ---
        const prompt = `请将下面的语音内容转换成文字，并从中提取日历事件信息。今天是 ${today}。
你的任务：
1.  **理解对话**：听懂语音内容，理解说话者的意图。
2.  **提取关键信息**：找出事件的标题、开始时间（startDateTime）、结束时间（endDateTime）、地点（location）和任何备注（description）。
3.  **格式化输出**：以 JSON 格式返回结果。例如："title": "和李医生预约", "startDateTime": "2025-09-15T14:30:00", "endDateTime": "N/A", "location": "市中心医院", "description": "带上体检报告。"。请直接返回 JSON 对象，不要包含 markdown 格式。`;

        const payload = {
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: req.file.mimetype, data: audioBase64 } }] }],
            generationConfig: { "responseMimeType": "application/json" }
        };

        console.log('正在调用 Gemini API 处理语音...');
        const geminiResponse = await axios.post(geminiApiUrl, payload);
        const parsedEvent = JSON.parse(geminiResponse.data.candidates[0].content.parts[0].text);
        if (parsedEvent.error) { throw new Error(parsedEvent.error); }

        await createCalendarEvent(req, res, parsedEvent);

    } catch (error) {
        console.error('处理语音过程中发生错误:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '服务器处理语音失败', error: error.message });
    }
});


// --- 抽取的通用函数：创建日历事件 ---
async function createCalendarEvent(req, res, parsedEvent) {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    console.log('正在获取用户日历的默认时区...');
    const settings = await calendar.settings.get({ setting: 'timezone' });
    const userTimezone = settings.data.value;
    console.log(`获取成功，用户时区为: ${userTimezone}`);
    
    let endDateTime;
    // 确保 startDateTime 是有效字符串再创建 Date 对象
    const startDate = parsedEvent.startDateTime && parsedEvent.startDateTime !== 'N/A' 
        ? new Date(parsedEvent.startDateTime)
        : new Date(); // 如果没有开始时间，则使用当前时间作为备用

    if (parsedEvent.startDateTime === 'N/A') {
        throw new Error("AI未能识别出有效的开始时间。");
    }

    if (parsedEvent.endDateTime === 'N/A' || !parsedEvent.endDateTime) {
        startDate.setHours(startDate.getHours() + 1);
        endDateTime = startDate.toISOString().slice(0, 19);
    } else {
        endDateTime = parsedEvent.endDateTime;
    }

    const event = {
      summary: parsedEvent.title,
      location: parsedEvent.location,
      description: parsedEvent.description,
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
}


// --- 根路由 ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 导出 app 供 Vercel 使用 ---
module.exports = app;

