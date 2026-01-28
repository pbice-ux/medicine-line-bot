const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ================== CONFIG ==================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

// ================== FILE-BASED STORAGE ==================
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error('Error loading data:', error);
  }
  return {};
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

function getUser(userId) {
  const data = loadData();
  if (!data[userId]) {
    data[userId] = {
      medicines: [],
      settings: {
        time1: '08:00',
        time2: '20:00'
      },
      alertedMedicines: {}
    };
    saveData(data);
  }
  return data[userId];
}

function saveUser(userId, userData) {
  const data = loadData();
  data[userId] = userData;
  saveData(data);
}

// ================== REMINDER STATE ==================
const pendingReminders = new Map();

function setPendingReminder(userId, timeSlot) {
  pendingReminders.set(userId, {
    timeSlot: timeSlot,
    timestamp: Date.now()
  });
  
  setTimeout(() => {
    pendingReminders.delete(userId);
  }, 30 * 60 * 1000);
}

function getPendingReminder(userId) {
  const pending = pendingReminders.get(userId);
  if (!pending) return null;
  
  const elapsed = Date.now() - pending.timestamp;
  if (elapsed > 30 * 60 * 1000) {
    pendingReminders.delete(userId);
    return null;
  }
  
  return pending;
}

// ================== MEDICINE FUNCTIONS ==================

function addMedicine(userId, name, totalPills, pillsPerDose, timeSlot) {
  const user = getUser(userId);
  
  const medicine = {
    id: `med_${Date.now()}`,
    name: name,
    totalPills: parseInt(totalPills),
    remainingPills: parseInt(totalPills),
    pillsPerDose: parseInt(pillsPerDose),
    timeSlot: parseInt(timeSlot),
    createdAt: new Date().toISOString()
  };
  
  user.medicines.push(medicine);
  saveUser(userId, user);
  
  return medicine;
}

function takeMedicine(userId, medicineId) {
  const user = getUser(userId);
  const medicine = user.medicines.find(m => m.id === medicineId);
  
  if (!medicine) {
    return { success: false, message: 'ไม่พบยาที่ระบุ' };
  }
  
  if (medicine.remainingPills < medicine.pillsPerDose) {
    return { success: false, message: `❌ ยา ${medicine.name} หมดแล้ว!` };
  }
  
  medicine.remainingPills -= medicine.pillsPerDose;
  saveUser(userId, user);
  
  let lowStockAlert = null;
  const alertKey = `${medicineId}`;
  
  if (medicine.remainingPills <= 5 && (!user.alertedMedicines[alertKey] || user.alertedMedicines[alertKey] < 2)) {
    lowStockAlert = { medicine, alertNumber: 2 };
    user.alertedMedicines[alertKey] = 2;
    saveUser(userId, user);
  } else if (medicine.remainingPills <= 10 && medicine.remainingPills > 5 && !user.alertedMedicines[alertKey]) {
    lowStockAlert = { medicine, alertNumber: 1 };
    user.alertedMedicines[alertKey] = 1;
    saveUser(userId, user);
  }
  
  return { 
    success: true, 
    medicine,
    lowStockAlert
  };
}

function refillMedicine(userId, medicineName, amount) {
  const user = getUser(userId);
  const medicine = user.medicines.find(m => 
    m.name.toLowerCase().includes(medicineName.toLowerCase())
  );
  
  if (!medicine) {
    return { success: false, message: 'ไม่พบยาที่ระบุ' };
  }
  
  medicine.remainingPills += parseInt(amount);
  delete user.alertedMedicines[medicine.id];
  saveUser(userId, user);
  
  return { success: true, medicine };
}

function setTime(userId, slot, time) {
  const user = getUser(userId);
  
  if (slot === 1) {
    user.settings.time1 = time;
  } else {
    user.settings.time2 = time;
  }
  
  saveUser(userId, user);
  return user.settings;
}

function deleteMedicine(userId, medicineName) {
  const user = getUser(userId);
  const index = user.medicines.findIndex(m => 
    m.name.toLowerCase().includes(medicineName.toLowerCase())
  );
  
  if (index === -1) {
    return { success: false, message: 'ไม่พบยาที่ระบุ' };
  }
  
  const deleted = user.medicines.splice(index, 1)[0];
  delete user.alertedMedicines[deleted.id];
  saveUser(userId, user);
  
  return { success: true, medicine: deleted };
}

// ================== MESSAGE BUILDERS ==================

function createReminderMessage(medicines, timeSlot, settings) {
  const timeDisplay = timeSlot === 1 ? settings.time1 : settings.time2;
  
  let message = `🔔 เตือนกินยาครั้งที่ ${timeSlot} (${timeDisplay} น.)\n`;
  message += `━━━━━━━━━━━━━━━━━━\n`;
  
  medicines.forEach((med) => {
    message += `\n💊 ${med.name}\n`;
    message += `   • กิน ${med.pillsPerDose} เม็ด\n`;
    message += `   • คงเหลือ ${med.remainingPills} เม็ด\n`;
  });
  
  message += `\n━━━━━━━━━━━━━━━━━━\n`;
  message += `✅ ตอบกลับด้วย:\n`;
  message += `• พิมพ์ "กินแล้ว"\n`;
  message += `• หรือส่ง Sticker อะไรก็ได้!`;
  
  return message;
}

function createLowStockMessage(medicine, alertNumber) {
  let message = `⚠️ เตือนยาใกล้หมดครั้งที่ ${alertNumber}\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  message += `💊 ${medicine.name}\n`;
  message += `   • เหลือเพียง ${medicine.remainingPills} เม็ด\n`;
  
  if (alertNumber === 1) {
    message += `   • ⚡ ควรเตรียมซื้อยาเพิ่ม\n`;
  } else {
    message += `   • 🚨 ยาใกล้หมดมาก!\n`;
  }
  
  message += `\n━━━━━━━━━━━━━━━━━━\n`;
  message += `📦 พิมพ์ "เติม [ชื่อยา] [จำนวน]" เมื่อเติมยาแล้ว`;
  
  return message;
}

function createDailySummary(user) {
  if (!user.medicines || user.medicines.length === 0) {
    return null;
  }
  
  let message = `📊 สรุปจำนวนยาทั้งหมด\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  
  user.medicines.forEach(med => {
    const warning = med.remainingPills <= 10 ? ' ⚠️' : '';
    const timeText = med.timeSlot === 1 ? '(เวลา 1)' : '(เวลา 2)';
    message += `💊 ${med.name} ${timeText}${warning}\n`;
    message += `   • จำนวน: ${med.remainingPills} เม็ด\n\n`;
  });
  
  message += `━━━━━━━━━━━━━━━━━━\n`;
  message += `⏰ เวลา 1: ${user.settings.time1} น.\n`;
  message += `⏰ เวลา 2: ${user.settings.time2} น.`;
  
  return message;
}

// ================== WEBHOOK HANDLER ==================

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }
  
  const userId = event.source.userId;
  const user = getUser(userId);
  
  // 🎉 STICKER HANDLER - รับ Sticker ทุกตัว!
  if (event.message.type === 'sticker') {
    return handleStickerMessage(event, userId, user);
  }
  
  // 📝 TEXT HANDLER
  if (event.message.type === 'text') {
    return handleTextMessage(event, userId, user);
  }
  
  return Promise.resolve(null);
}

// ================== 🎉 STICKER HANDLER ==================

async function handleStickerMessage(event, userId, user) {
  const pending = getPendingReminder(userId);
  
  if (!pending) {
    const now = new Date();
    const currentHour = now.getHours();
    const time1Hour = parseInt(user.settings.time1.split(':')[0]);
    const time2Hour = parseInt(user.settings.time2.split(':')[0]);
    
    let currentSlot = null;
    if (Math.abs(currentHour - time1Hour) <= 2) {
      currentSlot = 1;
    } else if (Math.abs(currentHour - time2Hour) <= 2) {
      currentSlot = 2;
    }
    
    if (!currentSlot) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '👋 สวัสดีครับ!\n\nพิมพ์ "help" เพื่อดูคำสั่งทั้งหมด'
      });
    }
    
    return processTakeMedicine(event, userId, user, currentSlot);
  }
  
  return processTakeMedicine(event, userId, user, pending.timeSlot);
}

// ================== PROCESS TAKE MEDICINE ==================

async function processTakeMedicine(event, userId, user, timeSlot) {
  const medicinesToTake = user.medicines.filter(m => 
    m.timeSlot === timeSlot && m.remainingPills > 0
  );
  
  if (medicinesToTake.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `📭 ไม่มียาที่ต้องกินในเวลาที่ ${timeSlot}`
    });
  }
  
  let resultMessage = `✅ บันทึกการกินยาแล้ว!\n━━━━━━━━━━━━━━━━━━\n`;
  const lowStockAlerts = [];
  
  for (const med of medicinesToTake) {
    const result = takeMedicine(userId, med.id);
    if (result.success) {
      resultMessage += `\n💊 ${result.medicine.name}\n`;
      resultMessage += `   • กิน ${result.medicine.pillsPerDose} เม็ด\n`;
      resultMessage += `   • คงเหลือ ${result.medicine.remainingPills} เม็ด\n`;
      
      if (result.lowStockAlert) {
        lowStockAlerts.push(result.lowStockAlert);
      }
    }
  }
  
  resultMessage += `\n━━━━━━━━━━━━━━━━━━\n`;
  resultMessage += `🎉 เยี่ยมมาก! อย่าลืมกินยาทุกวันนะ`;
  
  pendingReminders.delete(userId);
  
  const messages = [{ type: 'text', text: resultMessage }];
  
  for (const alert of lowStockAlerts) {
    messages.push({
      type: 'text',
      text: createLowStockMessage(alert.medicine, alert.alertNumber)
    });
  }
  
  return client.replyMessage(event.replyToken, messages);
}

// ================== 📝 TEXT HANDLER ==================

async function handleTextMessage(event, userId, user) {
  const text = event.message.text.trim();
  
  // 📋 ดูรายการยา
  if (/^(ยา|รายการยา|ดูยา)$/i.test(text)) {
    if (!user.medicines || user.medicines.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📭 คุณยังไม่มียาในระบบ\n\nพิมพ์ "เพิ่ม [ชื่อยา] [จำนวน] [เม็ด/ครั้ง] [1 หรือ 2]"\nตัวอย่าง: เพิ่ม พาราเซตามอล 30 2 1'
      });
    }
    
    const summary = createDailySummary(user);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: summary
    });
  }
  
  // ➕ เพิ่มยา
  const addMatch = text.match(/^เพิ่ม\s+(.+?)\s+(\d+)\s+(\d+)\s+([12])$/i);
  if (addMatch) {
    const [, name, total, perDose, slot] = addMatch;
    const medicine = addMedicine(userId, name, total, perDose, slot);
    const updatedUser = getUser(userId);
    const timeDisplay = slot === '1' ? updatedUser.settings.time1 : updatedUser.settings.time2;
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ เพิ่มยาสำเร็จ!\n━━━━━━━━━━━━━━━━━━\n\n💊 ${medicine.name}\n   • จำนวน: ${medicine.totalPills} เม็ด\n   • กินครั้งละ: ${medicine.pillsPerDose} เม็ด\n   • เวลาที่ ${slot} (${timeDisplay} น.)\n\n━━━━━━━━━━━━━━━━━━\n📌 บอทจะแจ้งเตือนตามเวลาที่ตั้งไว้`
    });
  }
  
  // ⏰ ตั้งเวลา
  const timeMatch = text.match(/^ตั้งเวลา\s*([12])\s+(\d{1,2})[.:](\d{2})$/i);
  if (timeMatch) {
    const [, slot, hour, minute] = timeMatch;
    const timeStr = `${hour.padStart(2, '0')}:${minute}`;
    setTime(userId, parseInt(slot), timeStr);
    
    const updatedUser = getUser(userId);
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ ตั้งเวลาที่ ${slot} เป็น ${timeStr} น. แล้ว\n\n⏰ เวลา 1: ${updatedUser.settings.time1} น.\n⏰ เวลา 2: ${updatedUser.settings.time2} น.`
    });
  }
  
  // ✅ กินยาแล้ว
  if (/^(กินแล้ว|กินยาแล้ว|ทานแล้ว|ok|โอเค)$/i.test(text)) {
    const pending = getPendingReminder(userId);
    
    const now = new Date();
    const currentHour = now.getHours();
    const time1Hour = parseInt(user.settings.time1.split(':')[0]);
    const time2Hour = parseInt(user.settings.time2.split(':')[0]);
    
    let currentSlot = pending?.timeSlot || null;
    
    if (!currentSlot) {
      if (Math.abs(currentHour - time1Hour) <= 2) {
        currentSlot = 1;
      } else if (Math.abs(currentHour - time2Hour) <= 2) {
        currentSlot = 2;
      }
    }
    
    if (!currentSlot) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❓ ไม่พบยาที่ต้องกินในเวลานี้\n\nพิมพ์ "กิน [ชื่อยา]" เพื่อระบุยาที่ต้องการ\nหรือ "กินยา 1" / "กินยา 2" เพื่อระบุเวลา'
      });
    }
    
    return processTakeMedicine(event, userId, user, currentSlot);
  }
  
  // ✅ กินยาเวลาที่ 1 หรือ 2
  const takeSlotMatch = text.match(/^กินยา\s*([12])$/i);
  if (takeSlotMatch) {
    const [, slot] = takeSlotMatch;
    return processTakeMedicine(event, userId, user, parseInt(slot));
  }
  
  // 💊 กินยาเฉพาะตัว
  const takeMatch = text.match(/^กิน\s+(.+)$/i);
  if (takeMatch) {
    const [, medicineName] = takeMatch;
    const medicine = user.medicines.find(m => 
      m.name.toLowerCase().includes(medicineName.toLowerCase())
    );
    
    if (!medicine) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `❌ ไม่พบยา "${medicineName}" ในระบบ`
      });
    }
    
    const result = takeMedicine(userId, medicine.id);
    
    if (!result.success) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: result.message
      });
    }
    
    const messages = [{
      type: 'text',
      text: `✅ กินยา ${result.medicine.name} แล้ว\n   • กิน ${result.medicine.pillsPerDose} เม็ด\n   • คงเหลือ ${result.medicine.remainingPills} เม็ด`
    }];
    
    if (result.lowStockAlert) {
      messages.push({
        type: 'text',
        text: createLowStockMessage(result.lowStockAlert.medicine, result.lowStockAlert.alertNumber)
      });
    }
    
    return client.replyMessage(event.replyToken, messages);
  }
  
  // 📦 เติมยา
  const refillMatch = text.match(/^เติม\s+(.+?)\s+(\d+)$/i);
  if (refillMatch) {
    const [, medicineName, amount] = refillMatch;
    const result = refillMedicine(userId, medicineName, amount);
    
    if (!result.success) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: result.message
      });
    }
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ เติมยาสำเร็จ!\n\n💊 ${result.medicine.name}\n   • เติม ${amount} เม็ด\n   • รวมคงเหลือ ${result.medicine.remainingPills} เม็ด`
    });
  }
  
  // 🗑️ ลบยา
  const deleteMatch = text.match(/^ลบ\s+(.+)$/i);
  if (deleteMatch) {
    const [, medicineName] = deleteMatch;
    const result = deleteMedicine(userId, medicineName);
    
    if (!result.success) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: result.message
      });
    }
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ ลบยา "${result.medicine.name}" แล้ว`
    });
  }
  
  // 📊 สรุป/สถานะ
  if (/^(สรุป|สถานะ|status)$/i.test(text)) {
    const summary = createDailySummary(user);
    if (!summary) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📭 ไม่มียาในระบบ'
      });
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: summary
    });
  }
  
  // ⏰ ดูเวลา
  if (/^(เวลา|ดูเวลา)$/i.test(text)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `⏰ เวลาเตือนยาของคุณ\n━━━━━━━━━━━━━━━━━━\n\n⏰ เวลา 1: ${user.settings.time1} น.\n⏰ เวลา 2: ${user.settings.time2} น.\n\n━━━━━━━━━━━━━━━━━━\n📝 เปลี่ยนเวลา:\nตั้งเวลา 1 08.00\nตั้งเวลา 2 20.00`
    });
  }
  
  // ❓ Help
  if (/^(help|ช่วยเหลือ|คำสั่ง|วิธีใช้|\?)$/i.test(text)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `💊 คำสั่ง Medicine Bot
━━━━━━━━━━━━━━━━━━

📋 ดูรายการยา
   พิมพ์: ยา

➕ เพิ่มยา
   พิมพ์: เพิ่ม [ชื่อ] [จำนวน] [เม็ด/ครั้ง] [1 หรือ 2]
   ตัวอย่าง: เพิ่ม ยาลดความดัน 30 1 1

✅ บันทึกกินยา
   • พิมพ์: กินแล้ว / ok
   • ส่ง Sticker อะไรก็ได้!
   • พิมพ์: กินยา 1 / กินยา 2
   • พิมพ์: กิน [ชื่อยา]

📦 เติมยา
   พิมพ์: เติม [ชื่อยา] [จำนวน]

🗑️ ลบยา
   พิมพ์: ลบ [ชื่อยา]

⏰ ตั้งเวลา
   พิมพ์: ตั้งเวลา 1 08.00
   พิมพ์: ตั้งเวลา 2 20.00

📊 ดูสรุป
   พิมพ์: สรุป

━━━━━━━━━━━━━━━━━━
🔔 บอทเตือนอัตโนมัติ:
• เตือนกินยาตามเวลาที่ตั้ง
• สรุปยาทุกวันตอนเที่ยง
• เตือนยาเหลือ 10/5 เม็ด`
    });
  }
  
  // Default
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '💊 พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด'
  });
}

// ================== SCHEDULED JOBS ==================

async function sendReminders(timeSlot) {
  const data = loadData();
  
  for (const [userId, user] of Object.entries(data)) {
    const targetTime = timeSlot === 1 ? user.settings.time1 : user.settings.time2;
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    if (currentTime !== targetTime) continue;
    
    const medicines = user.medicines.filter(m => m.timeSlot === timeSlot && m.remainingPills > 0);
    
    if (medicines.length === 0) continue;
    
    const message = createReminderMessage(medicines, timeSlot, user.settings);
    
    try {
      await client.pushMessage(userId, { type: 'text', text: message });
      setPendingReminder(userId, timeSlot);
      console.log(`✅ Sent reminder to ${userId} for time ${timeSlot}`);
    } catch (error) {
      console.error(`❌ Failed to send reminder to ${userId}:`, error.message);
    }
  }
}

async function sendDailySummary() {
  const data = loadData();
  
  for (const [userId, user] of Object.entries(data)) {
    const summary = createDailySummary(user);
    if (!summary) continue;
    
    try {
      await client.pushMessage(userId, { type: 'text', text: summary });
      console.log(`✅ Sent daily summary to ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to send summary to ${userId}:`, error.message);
    }
  }
}

// เช็คทุกนาที
cron.schedule('* * * * *', () => {
  sendReminders(1);
  sendReminders(2);
}, { timezone: 'Asia/Bangkok' });

// สรุปยาทุกวันตอนเที่ยง
cron.schedule('0 12 * * *', () => {
  console.log('📊 Sending daily summaries...');
  sendDailySummary();
}, { timezone: 'Asia/Bangkok' });

// ================== SERVER ==================

app.get('/', (req, res) => {
  res.send('💊 Medicine Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💊 Medicine Bot running on port ${PORT}`);
});
