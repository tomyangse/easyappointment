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
        // --- 语音处理专属指令 ---
        const prompt = `请将下面的语音内容转换成文字，并从中提取日历事件信息。今天是 ${today}。
你的任务：
1.  **理解对话**：听懂语音内容，理解说话者的意图。
2.  **提取关键信息**：找出事件的标题、开始时间（startDateTime）、结束时间（endDateTime）、地点（location）和任何备注（description）。
3.  **格式化输出**：以 JSON 格式返回结果。将时间转换为不含时区信息的 ISO 8601 字符串（例如 "2025-09-15T14:30:00"）。例如："title": "和李医生预约", "startDateTime": "2025-09-15T14:30:00", "endDateTime": "N/A", "location": "市中心医院", "description": "带上体检报告。"。请直接返回 JSON 对象，不要包含 markdown 格式。`;

        const payload = {
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: req.file.mimetype, data: audioBase64 } }] }],
            generationConfig: { "responseMimeType": "application/json" }
        };

        console.log('正在调用 Gemini API 处理语音...');
        const geminiResponse = await axios.post(geminiApiUrl, payload);
        const parsedEvent = JSON.parse(geminiResponse.data.candidates[0].content.parts[0].text);
        
        // --- 新增的诊断日志 ---
        console.log('Gemini 语音识别原始结果:', JSON.stringify(parsedEvent, null, 2));

        if (parsedEvent.error) { throw new Error(parsedEvent.error); }

        await createCalendarEvent(req, res, parsedEvent);

    } catch (error) {
        console.error('处理语音过程中发生错误:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '服务器处理语音失败', error: error.message });
    }
});


// ... (The rest of the file is unchanged) ...

