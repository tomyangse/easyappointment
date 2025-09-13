// ... (The beginning of the file is unchanged) ...

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
        // --- 最终指令优化：更聚焦、更明确 ---
        const prompt = `将语音内容转换为日历事件。今天是 ${today}。
你的任务是：从语音中找出事件的标题、开始时间(startDateTime)、地点(location)和描述(description)。
- **必须**将 "明天"、"下周一" 等相对时间转换为 'YYYY-MM-DDTHH:mm:ss' 格式。
- 如果找不到某个信息，则将其值设为 "N/A"。
- 直接以 JSON 对象格式返回，不要包含 markdown。
例如，如果用户说“下周一下午两点和王医生在诊所有个复查”，你应该返回类似：
{
  "title": "与王医生复查",
  "startDateTime": "2025-09-22T14:00:00",
  "endDateTime": "N/A",
  "location": "诊所",
  "description": ""
}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: req.file.mimetype, data: audioBase64 } }] }],
            generationConfig: { "responseMimeType": "application/json" }
        };

        console.log('正在调用 Gemini API 处理语音...');
        const geminiResponse = await axios.post(geminiApiUrl, payload);
        const parsedEvent = JSON.parse(geminiResponse.data.candidates[0].content.parts[0].text);
        
        console.log('Gemini 语音识别原始结果:', JSON.stringify(parsedEvent, null, 2));

        if (parsedEvent.error) { throw new Error(parsedEvent.error); }

        await createCalendarEvent(req, res, parsedEvent);

    } catch (error) {
        console.error('处理语音过程中发生错误:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '服务器处理语音失败', error: error.message });
    }
});


// ... (The rest of the file is unchanged) ...

