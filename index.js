const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { Redis } = require('@upstash/redis'); // 📦 เรียกใช้ Redis

// ================== CONFIG (ตั้งค่า) ==================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// 🔥 ใช้ Environment Variables เพื่อความปลอดภัย
// ตรงนี้จะดึง URL และ Token จากการตั้งค่าใน Render (ไม่ใส่รหัสตรงๆ ในโค้ด)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const client = new line.Client(config);
const app = express();

// ================== HELPER: TIMEZONE (จัดการเวลา) ==================
// ฟังก์ชันช่วยดึงเวลาไทย (แก้ปัญหา Server เวลาไม่ตรง)
function getThaiDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
}

// ================== REDIS STORAGE (ส่วนเก็บข้อมูล) ==================

// 📥 โหลดข้อมูล: เปลี่ยนจากอ่านไฟล์ มาเป็นอ่านจาก Redis
async function loadData() {
  try {
    const data = await redis.get('medicine_bot_data');
    return data || {}; // ถ้าไม่มีข้อมูล ให้คืนค่าว่างกลับไป
  } catch (error) {
    console.error('Error loading data:', error);
    return {};
  }
}

// 💾 บันทึกข้อมูล: เปลี่ยนจากเขียนไฟล์ เป็นส่งไปเก็บที่ Redis
async function saveData(data) {
  try {
    await redis.set('medicine_bot_data', data);
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// ดึงข้อมูล User (ต้องมี async เพราะต้องรอ Redis)
async function getUser(userId) {
  const data = await loadData();
  if (!data[userId]) {
    // ถ้ายังไม่มี User นี้ ให้สร้างใหม่
    data[userId] = {
      medicines: [],
      settings: {
        time1: '08:00',
        time2: '20:00'
      },
      alertedMedicines: {}
    };
    await saveData(data);
  }
  return data[userId];
}

// บันทึกข้อมูล User (ต้องมี async)
async function saveUser(userId, userData) {
  const data = await loadData();
  data[userId] = userData;
  await saveData(data);
}

// ================== REMINDER STATE (สถานะการรอเตือน) ==================
// ส่วนนี้ใช้ Memory ชั่วคราวได้ เพราะเป็นการรอแค่ 30 นาที ไม่ซีเรียสถ้าหายตอน Restart
const pendingReminders = new Map();

function setPendingReminder(userId, timeSlot) {
  pendingReminders.set(userId, {
    timeSlot: timeSlot,
    timestamp: Date.now()
  });
  
  // ลบสถานะทิ้งถ้าผ่านไป 30 นาทีแล้วยังไม่ตอบ
  setTimeout(() => {
    pendingReminders.delete(userId);
  }, 30 * 60 * 1000);
}

function getPendingReminder(userId) {
  const pending = pendingReminders.get(userId);
  if (!pending) return null;
  
  // เช็คอีกรอบว่าเกิน 30 นาทีไหม
  const elapsed = Date.now() - pending.timestamp;
  if (elapsed > 30 * 60 * 1000) {
    pendingReminders.delete(userId);
    return null;
  }
  return pending;
}

// ================== MEDICINE FUNCTIONS (ฟังก์ชันเกี่ยวกับยา) ==================

// เพิ่มยาใหม่
async function addMedicine(userId, name, totalPills, pillsPerDose, timeSlot) {
  const user = await getUser(userId); // ต้องรอข้อมูลจาก Redis
  
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
  await saveUser(userId, user); // บันทึกกลับเข้า Redis
  
  return medicine;
}

// กินยา (ตัดสต็อก)
async function takeMedicine(userId, medicineId) {
  const user = await getUser(userId);
  const medicine = user.medicines.find(m => m.id === medicineId);
  
  if (!medicine) {
    return { success: false, message: 'ไม่พบยาที่ระบุ' };
  }
  
  if (medicine.remainingPills < medicine.pillsPerDose) {
    return { success: false, message: `❌ ยา ${medicine.name} หมดแล้ว!` };
  }
  
  medicine.remainingPills -= medicine.pillsPerDose;
  
  // --- ส่วนเช็คยาใกล้หมด ---
  let lowStockAlert = null;
  const alertKey = `${medicineId}`;
  
  // เตือนครั้งที่ 2 (เหลือ <= 5 เม็ด)
  if (medicine.remainingPills <= 5 && (!user.alertedMedicines[alertKey] || user.alertedMedicines[alertKey] < 2)) {
    lowStockAlert = { medicine, alertNumber: 2 };
    user.alertedMedicines[alertKey] = 2;
  } 
  // เตือนครั้งที่ 1 (เหลือ <= 10 เม็ด)
  else if (medicine.remainingPills <= 10 && medicine.remainingPills > 5 && !user.alertedMedicines[alertKey]) {
    lowStockAlert = { medicine, alertNumber: 1 };
    user.alertedMedicines[alertKey] = 1;
  }

  await saveUser(userId, user);
  
  return { 
    success: true, 
    medicine,
    lowStockAlert
  };
}

// เติมยา
async function refillMedicine(userId, medicineName, amount) {
  const user = await getUser(userId);
  const medicine = user.medicines.find(m => 
    m.name.toLowerCase().includes(medicineName.toLowerCase())
  );
  
  if (!medicine) {
    return { success: false, message: 'ไม่พบยาที่ระบุ' };
  }
  
  medicine.remainingPills += parseInt(amount);
  
  // ลบประวัติการเตือนยาหมด เพื่อให้เตือนใหม่ได้ในรอบหน้า
  if (user.alertedMedicines && user.alertedMedicines[medicine.id]) {
      delete user.alertedMedicines[medicine.id];
  }

  await saveUser(userId, user);
  
  return { success: true, medicine };
}

// ตั้งเวลา
async function setTime(userId, slot, time) {
  const user = await getUser(userId);
  
  if (slot === 1) {
    user.settings.time1 = time;
  } else {
    user.settings.time2 = time;
  }
  
  await saveUser(userId, user);
  return user.settings;
}

// ลบยา
async function deleteMedicine(userId, medicineName) {
  const user = await getUser(userId);
  const index = user.medicines.findIndex(m => 
    m.name.toLowerCase().includes(medicineName.toLowerCase())
  );
  
  if (index === -1) {
    return { success: false, message: 'ไม่พบยาที่ระบุ' };
  }
  
  const deleted = user.medicines.splice(index, 1)[0];
  
  // ลบข้อมูลการแจ้งเตือนของยาตัวนี้ด้วย
  if (user.alertedMedicines && user.alertedMedicines[deleted.id]) {
    delete user.alertedMedicines[deleted.id];
  }

  await saveUser(userId, user);
  
  return { success: true, medicine: deleted };
}

// ================== MESSAGE BUILDERS (สร้างข้อความตอบกลับ) ==================

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

// ================== WEBHOOK HANDLER (รับข้อความจาก LINE) ==================

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    // ใช้ Promise.all เพื่อรอให้บอทตอบเสร็จทุกข้อความก่อน
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') {
    return null;
  }
  
  const userId = event.source.userId;
  const user = await getUser(userId); // โหลด User จาก Redis
  
  // 🎉 ถ้าส่ง Sticker มา (ถือว่ากินยา)
  if (event.message.type === 'sticker') {
    return await handleStickerMessage(event, userId, user);
  }
  
  // 📝 ถ้าพิมพ์ข้อความมา
  if (event.message.type === 'text') {
    return await handleTextMessage(event, userId, user);
  }
  
  return null;
}

// ================== STICKER HANDLER (จัดการสติกเกอร์) ==================

async function handleStickerMessage(event, userId, user) {
  const pending = getPendingReminder(userId);
  
  if (!pending) {
    // ถ้าไม่มีการรอเตือน ให้เช็คเวลาปัจจุบัน
    const now = getThaiDate();
    const currentHour = now.getHours();
    
    const time1Hour = parseInt(user.settings.time1.split(':')[0]);
    const time2Hour = parseInt(user.settings.time2.split(':')[0]);
    
    let currentSlot = null;
    // อนุโลมให้ตอบก่อน/หลังเวลาได้ 2 ชั่วโมง
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
    
    return await processTakeMedicine(event, userId, user, currentSlot);
  }
  
  // ถ้ามีการรอเตือนอยู่ (Pending) ให้ถือว่าตอบรับรอบนั้น
  return await processTakeMedicine(event, userId, user, pending.timeSlot);
}

// ================== PROCESS TAKE MEDICINE (ประมวลผลการกินยา) ==================

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
    const result = await takeMedicine(userId, med.id); 
    
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
  
  // แทรกข้อความเตือนยาหมด ถ้ามี
  for (const alert of lowStockAlerts) {
    messages.push({
      type: 'text',
      text: createLowStockMessage(alert.medicine, alert.alertNumber)
    });
  }
  
  return client.replyMessage(event.replyToken, messages);
}

// ================== TEXT HANDLER (จัดการข้อความ) ==================

async function handleTextMessage(event, userId, user) {
  const text = event.message.text.trim();
  
  // --- ดูรายการยา ---
  if (/^(ยา|รายการยา|ดูยา)$/i.test(text)) {
    if (!user.medicines || user.medicines.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📭 คุณยังไม่มียาในระบบ\n\nพิมพ์ "เพิ่ม [ชื่อยา] [จำนวน] [เม็ด/ครั้ง] [1 หรือ 2]"\nตัวอย่าง: เพิ่ม พาราเซตามอล 30 2 1'
      });
    }
    const summary = createDailySummary(user);
    return client.replyMessage(event.replyToken, { type: 'text', text: summary });
  }
  
  // --- เพิ่มยา ---
  const addMatch = text.match(/^เพิ่ม\s+(.+?)\s+(\d+)\s+(\d+)\s+([12])$/i);
  if (addMatch) {
    const [, name, total, perDose, slot] = addMatch;
    const medicine = await addMedicine(userId, name, total, perDose, slot);
    const updatedUser = await getUser(userId);
    const timeDisplay = slot === '1' ? updatedUser.settings.time1 : updatedUser.settings.time2;
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ เพิ่มยาสำเร็จ!\n━━━━━━━━━━━━━━━━━━\n\n💊 ${medicine.name}\n   • จำนวน: ${medicine.totalPills} เม็ด\n   • กินครั้งละ: ${medicine.pillsPerDose} เม็ด\n   • เวลาที่ ${slot} (${timeDisplay} น.)\n\n━━━━━━━━━━━━━━━━━━\n📌 บอทจะแจ้งเตือนตามเวลาที่ตั้งไว้`
    });
  }
  
  // --- ตั้งเวลา ---
  const timeMatch = text.match(/^ตั้งเวลา\s*([12])\s+(\d{1,2})[.:](\d{2})$/i);
  if (timeMatch) {
    const [, slot, hour, minute] = timeMatch;
    const timeStr = `${hour.padStart(2, '0')}:${minute}`;
    await setTime(userId, parseInt(slot), timeStr);
    const updatedUser = await getUser(userId);
    
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ ตั้งเวลาที่ ${slot} เป็น ${timeStr} น. แล้ว\n\n⏰ เวลา 1: ${updatedUser.settings.time1} น.\n⏰ เวลา 2: ${updatedUser.settings.time2} น.`
    });
  }
  
  // --- แจ้งกินยาแล้ว ---
  if (/^(กินแล้ว|กินยาแล้ว|ทานแล้ว|ok|โอเค)$/i.test(text)) {
    const pending = getPendingReminder(userId);
    const now = getThaiDate();
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
    return await processTakeMedicine(event, userId, user, currentSlot);
  }
  
  // --- กินยาตามรอบเวลา (1 หรือ 2) ---
  const takeSlotMatch = text.match(/^กินยา\s*([12])$/i);
  if (takeSlotMatch) {
    const [, slot] = takeSlotMatch;
    return await processTakeMedicine(event, userId, user, parseInt(slot));
  }
  
  // --- กินยาเฉพาะตัว (ระบุชื่อ) ---
  const takeMatch = text.match(/^กิน\s+(.+)$/i);
  if (takeMatch) {
    const [, medicineName] = takeMatch;
    const medicine = user.medicines.find(m => m.name.toLowerCase().includes(medicineName.toLowerCase()));
    
    if (!medicine) {
      return client.replyMessage(event.replyToken, { type: 'text', text: `❌ ไม่พบยา "${medicineName}" ในระบบ` });
    }
    
    const result = await takeMedicine(userId, medicine.id);
    if (!result.success) {
      return client.replyMessage(event.replyToken, { type: 'text', text: result.message });
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
  
  // --- เติมยา ---
  const refillMatch = text.match(/^เติม\s+(.+?)\s+(\d+)$/i);
  if (refillMatch) {
    const [, medicineName, amount] = refillMatch;
    const result = await refillMedicine(userId, medicineName, amount);
    if (!result.success) {
      return client.replyMessage(event.replyToken, { type: 'text', text: result.message });
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ เติมยาสำเร็จ!\n\n💊 ${result.medicine.name}\n   • เติม ${amount} เม็ด\n   • รวมคงเหลือ ${result.medicine.remainingPills} เม็ด`
    });
  }
  
  // --- ลบยา ---
  const deleteMatch = text.match(/^ลบ\s+(.+)$/i);
  if (deleteMatch) {
    const [, medicineName] = deleteMatch;
    const result = await deleteMedicine(userId, medicineName);
    if (!result.success) {
      return client.replyMessage(event.replyToken, { type: 'text', text: result.message });
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: `✅ ลบยา "${result.medicine.name}" แล้ว` });
  }
  
  // --- ดูสรุป ---
  if (/^(สรุป|สถานะ|status)$/i.test(text)) {
    const summary = createDailySummary(user);
    if (!summary) return client.replyMessage(event.replyToken, { type: 'text', text: '📭 ไม่มียาในระบบ' });
    return client.replyMessage(event.replyToken, { type: 'text', text: summary });
  }
  
  // --- ดูเวลา ---
  if (/^(เวลา|ดูเวลา)$/i.test(text)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `⏰ เวลาเตือนยาของคุณ\n━━━━━━━━━━━━━━━━━━\n\n⏰ เวลา 1: ${user.settings.time1} น.\n⏰ เวลา 2: ${user.settings.time2} น.\n\n━━━━━━━━━━━━━━━━━━\n📝 เปลี่ยนเวลา:\nตั้งเวลา 1 08.00\nตั้งเวลา 2 20.00`
    });
  }
  
  // --- Help / ช่วยเหลือ ---
  if (/^(help|ช่วยเหลือ|คำสั่ง|วิธีใช้|\?)$/i.test(text)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `💊 คำสั่ง Medicine Bot
━━━━━━━━━━━━━━━━━━
📋 ดูรายการยา: พิมพ์ "ยา"
➕ เพิ่มยา: พิมพ์ "เพิ่ม [ชื่อ] [จำนวน] [เม็ด/ครั้ง] [1 หรือ 2]"
✅ กินยา: พิมพ์ "กินแล้ว", ส่งสติกเกอร์, หรือ "กิน [ชื่อยา]"
📦 เติมยา: พิมพ์ "เติม [ชื่อยา] [จำนวน]"
🗑️ ลบยา: พิมพ์ "ลบ [ชื่อยา]"
⏰ ตั้งเวลา: พิมพ์ "ตั้งเวลา 1 08.00"
📊 ดูสรุป: พิมพ์ "สรุป"`
    });
  }
  
  return client.replyMessage(event.replyToken, { type: 'text', text: '💊 พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด' });
}

// ================== SCHEDULED JOBS (งานที่ตั้งเวลาไว้) ==================

// แจ้งเตือนกินยา
async function sendReminders(timeSlot) {
  const data = await loadData(); // รอโหลดข้อมูลจาก Redis
  
  for (const [userId, user] of Object.entries(data)) {
    const targetTime = timeSlot === 1 ? user.settings.time1 : user.settings.time2;
    
    // ใช้เวลาไทยในการเช็ค
    const now = getThaiDate();
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

// ส่งสรุปยาทุกเที่ยงวัน
async function sendDailySummary() {
  const data = await loadData();
  
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

// สรุปยอดตอน 12.00
cron.schedule('0 12 * * *', () => {
  console.log('📊 Sending daily summaries...');
  sendDailySummary();
}, { timezone: 'Asia/Bangkok' });

// ================== SERVER START ==================

app.get('/', (req, res) => {
  res.send('💊 Medicine Bot (Redis + Secure + Thai Comments) is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`💊 Medicine Bot running on port ${PORT}`);
});