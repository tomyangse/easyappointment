// ... (All existing code from the beginning of the file) ...

// --- 抽取的通用函数：创建日历事件 ---
async function createCalendarEvent(req, res, parsedEvent) {
    oauth2Client.setCredentials(req.session.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    console.log('正在获取用户日历的默认时区...');
    const settings = await calendar.settings.get({ setting: 'timezone' });
    const userTimezone = settings.data.value;
    console.log(`获取成功，用户时区为: ${userTimezone}`);
    
    // --- 健壮性修复：严格检查 startDateTime ---
    if (!parsedEvent.startDateTime || parsedEvent.startDateTime === 'N/A') {
        // 如果 AI 未能提供有效的开始时间，则直接抛出错误
        throw new Error("AI未能识别出有效的开始时间，请说得更具体一些，例如‘明天上午10点’。");
    }

    let endDateTime;
    // 使用 AI 返回的有效 startDateTime 来创建 Date 对象
    const startDate = new Date(parsedEvent.startDateTime); 

    if (parsedEvent.endDateTime === 'N/A' || !parsedEvent.endDateTime) {
        // 在有效的 startDate 基础上加一小时
        startDate.setHours(startDate.getHours() + 1);
        // 格式化为不含时区信息的 ISO 字符串
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


// ... (This section includes the routes: /auth/google, /auth/google/callback, etc. and remains unchanged) ...
app.post('/api/create-event-from-voice', upload.single('eventAudio'), async (req, res) => {
    // ... existing implementation
});


// --- 根路由 ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 最终修复：恢复这一行关键代码 ---
// --- 导出 app 供 Vercel 使用 ---
module.exports = app;

