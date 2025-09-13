// ... (The beginning of the file is unchanged) ...

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
    // --- 恢复最终的、最智能的 AI 指令 ---
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
    
// ... (The rest of the file is unchanged) ...

