require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Redis } = require("@upstash/redis");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// ===== Redis Setup =====
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

// ===== LINE Setup =====
const LINE_API = "https://api.line.me/v2/bot/message";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ===== User States =====
const userStates = {};

// ==================== LINE Functions ====================
async function reply(replyToken, text) {
  try {
    await axios.post(
      `${LINE_API}/reply`,
      {
        replyToken,
        messages: [{ type: "text", text }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      }
    );
  } catch (error) {
    console.error("❌ Reply Error:", error.response?.data || error.message);
  }
}

async function push(userId, text) {
  try {
    await axios.post(
      `${LINE_API}/push`,
      {
        to: userId,
        messages: [{ type: "text", text }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      }
    );
  } catch (error) {
    console.error("❌ Push Error:", error.response?.data || error.message);
  }
}

// ==================== Redis Functions ====================
async function getUser(lineUserId) {
  try {
    const data = await redis.get(`user:${lineUserId}`);
    if (!data) return null;
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (error) {
    console.error("❌ Redis Get Error:", error.message);
    return null;
  }
}

async function saveUser(lineUserId, userData) {
  try {
    await redis.set(`user:${lineUserId}`, JSON.stringify(userData));
  } catch (error) {
    console.error("❌ Redis Save Error:", error.message);
  }
}

async function getAllUsers() {
  try {
    const keys = await redis.keys("user:*");
    const users = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const user = typeof data === "string" ? JSON.parse(data) : data;
        users.push(user);
      }
    }
    return users;
  } catch (error) {
    console.error("❌ Redis GetAll Error:", error.message);
    return [];
  }
}

// ==================== Reminder System ====================
function startReminderSystem() {
  cron.schedule(
    "* * * * *",
    async () => {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;

      try {
        const users = await getAllUsers();

        for (const user of users) {
          const times = user.reminderTimes || ["08:00", "20:00"];
          if (times.includes(currentTime)) {
            const timeIndex = times.indexOf(currentTime) + 1;
            await sendDrugReminder(user, currentTime, timeIndex);
          }
        }
      } catch (error) {
        console.error("❌ Reminder Error:", error.message);
      }
    },
    { timezone: "Asia/Bangkok" }
  );

  console.log("✅ Reminder system started");
}

async function sendDrugReminder(user, time, timeNumber) {
  const drugs = user.drugs || [];

  let warning = "";
  drugs.forEach((drug) => {
    if (drug.quantity <= 0) {
      warning += `\n🚫 ${drug.name}: หมดแล้ว!`;
    } else if (drug.quantity <= 5) {
      warning += `\n🔴 ${drug.name}: เหลือ ${drug.quantity} เม็ด (ใกล้หมด!)`;
    } else if (drug.quantity <= 10) {
      warning += `\n🟡 ${drug.name}: เหลือ ${drug.quantity} เม็ด (เหลือน้อย)`;
    }
  });

  const drugList =
    drugs.length > 0
      ? drugs.map((d) => `💊 ${d.name} (${d.quantity} เม็ด)`).join("\n")
      : "ยังไม่มียาในระบบ";

  const message = `⏰ ถึงเวลากินยาแล้ว!
━━━━━━━━━━━━━━━━━━━
🕐 เวลาที่ ${timeNumber}: ${time} น.

📋 รายการยา:
${drugList}
${warning ? `\n⚠️ แจ้งเตือน:${warning}` : ""}
━━━━━━━━━━━━━━━━━━━
📝 วิธีบันทึกการกินยา:

✅ กินตรงเวลา:
   พิมพ์ "กินยา ${timeNumber}"

⏰ กินช้าเกิน 30 นาที:
   พิมพ์ "กินยาช้า ${timeNumber}"`;

  await push(user.lineUserId, message);
  console.log(`📤 Reminder sent to ${user.odotId} at ${time}`);
}

// ==================== Message Handler ====================
async function handleMessage(event) {
  const lineUserId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  try {
    if (userStates[lineUserId]) {
      return await handleUserState(replyToken, lineUserId, text);
    }

    if (text === "help" || text === "วิธีใช้" || text === "ช่วยเหลือ") {
      return await sendMainHelp(replyToken);
    }
    if (text.startsWith("help ") || text.startsWith("ช่วยเหลือ ")) {
      const topic = text.replace(/^(help |ช่วยเหลือ )/, "").trim();
      return await sendTopicHelp(replyToken, topic);
    }

    if (text.startsWith("ลงทะเบียน ")) {
      return await handleRegister(replyToken, text, lineUserId);
    }

    if (text.startsWith("เพิ่มยา ")) {
      return await handleAddDrug(replyToken, text, lineUserId);
    }

    if (text === "ดูยา" || text === "รายการยา") {
      return await handleShowDrugs(replyToken, lineUserId);
    }

    if (text === "เติมยา") {
      return await handleRefillStart(replyToken, lineUserId);
    }
    if (text.startsWith("เติมยา ")) {
      return await handleRefill(replyToken, text, lineUserId);
    }

    if (text === "ยกเลิกยา") {
      return await handleCancelStart(replyToken, lineUserId);
    }
    if (text.startsWith("ยกเลิกยา ")) {
      return await handleCancel(replyToken, text, lineUserId);
    }

    if (text === "เวลากินยา" || text === "ดูเวลากินยา") {
      return await handleShowTimes(replyToken, lineUserId);
    }
    if (text.startsWith("เพิ่มเวลากินยา ")) {
      return await handleAddTime(replyToken, text, lineUserId);
    }
    if (text.startsWith("ลบเวลากินยา ")) {
      return await handleRemoveTime(replyToken, text, lineUserId);
    }

    if (text.startsWith("กินยา ") && !text.startsWith("กินยาช้า")) {
      return await handleTakeDrug(replyToken, text, lineUserId, false);
    }

    if (text === "กินยาช้า") {
      return await handleLateStart(replyToken, lineUserId);
    }
    if (text.startsWith("กินยาช้า ")) {
      return await handleTakeDrug(replyToken, text, lineUserId, true);
    }

    return await reply(
      replyToken,
      `❓ ไม่เข้าใจคำสั่งค่ะ\n\n💡 พิมพ์ "help" หรือ "วิธีใช้" ดูคำสั่งทั้งหมด`
    );
  } catch (error) {
    console.error("❌ Error:", error.message);
    return await reply(replyToken, "❌ เกิดข้อผิดพลาด กรุณาลองใหม่ค่ะ");
  }
}

// ==================== User State Handler ====================
async function handleUserState(replyToken, lineUserId, text) {
  const state = userStates[lineUserId];

  if (state.action === "confirmCancel") {
    if (text === "ยืนยัน" || text === "ใช่" || text.toLowerCase() === "y") {
      const user = await getUser(lineUserId);
      const drugName = user.drugs[state.drugIndex].name;
      user.drugs.splice(state.drugIndex, 1);
      await saveUser(lineUserId, user);
      delete userStates[lineUserId];

      return await reply(replyToken, `✅ ลบยา "${drugName}" เรียบร้อยแล้วค่ะ`);
    } else {
      delete userStates[lineUserId];
      return await reply(replyToken, "❌ ยกเลิกการลบยาค่ะ");
    }
  }

  delete userStates[lineUserId];
  return null;
}

// ==================== HELP Functions ====================
async function sendMainHelp(replyToken) {
  const text = `📚 วิธีใช้งาน Bot เตือนกินยา
━━━━━━━━━━━━━━━━━━━━━

สวัสดีค่ะ! 👋
Bot นี้จะช่วยเตือนเวลากินยา
และจัดการยาของคุณค่ะ

━━━━━━━━━━━━━━━━━━━━━
📌 หมวดหมู่คำสั่ง:
━━━━━━━━━━━━━━━━━━━━━

1️⃣ เริ่มต้นใช้งาน → help ลงทะเบียน
2️⃣ จัดการยา → help เพิ่มยา
3️⃣ จัดการเวลา → help เวลากินยา
4️⃣ บันทึกการกิน → help กินยา

━━━━━━━━━━━━━━━━━━━━━
⚡ คำสั่งด่วน:
━━━━━━━━━━━━━━━━━━━━━
• ดูยา - ดูรายการยาทั้งหมด
• เวลากินยา - ดูเวลาเตือน
• เติมยา - เติมจำนวนยา

💡 พิมพ์ "help [หมวด]" เพื่อดูรายละเอียด`;

  return await reply(replyToken, text);
}

async function sendTopicHelp(replyToken, topic) {
  const helps = {
    ลงทะเบียน: `📝 วิธีลงทะเบียน
━━━━━━━━━━━━━━━━━━━
พิมพ์: ลงทะเบียน [รหัสผู้ป่วย]

📌 ตัวอย่าง:
ลงทะเบียน HN12345

✅ หลังลงทะเบียน:
• เวลาเตือนเริ่มต้น: 08:00, 20:00
• สามารถเพิ่มยาได้เลย`,

    เพิ่มยา: `💊 วิธีเพิ่มยา
━━━━━━━━━━━━━━━━━━━
พิมพ์: เพิ่มยา [ชื่อยา] [จำนวน]

📌 ตัวอย่าง:
• เพิ่มยา พาราเซตามอล 30
• เพิ่มยา ยาลดความดัน 20`,

    เติมยา: `📦 วิธีเติมยา
━━━━━━━━━━━━━━━━━━━
1. พิมพ์ "เติมยา"
2. ดูรายการยาพร้อมเลข
3. พิมพ์ "เติมยา [เลข] [จำนวน]"

📌 ตัวอย่าง:
เติมยา 1 30`,

    ยกเลิกยา: `🗑️ วิธียกเลิก/ลบยา
━━━━━━━━━━━━━━━━━━━
1. พิมพ์ "ยกเลิกยา"
2. ดูรายการยา
3. พิมพ์ "ยกเลิกยา [เลข]"
4. พิมพ์ "ยืนยัน" เพื่อลบ

⚠️ ลบแล้วไม่สามารถกู้คืนได้`,

    ดูยา: `📋 วิธีดูรายการยา
━━━━━━━━━━━━━━━━━━━
พิมพ์: ดูยา

🎨 ความหมายสัญลักษณ์:
✅ ยามีเพียงพอ (มากกว่า 10 เม็ด)
🟡 ยาเหลือน้อย (เหลือ 6-10 เม็ด)
🔴 ยาใกล้หมด (เหลือ 1-5 เม็ด)
🚫 ยาหมดแล้ว (0 เม็ด)`,

    เวลากินยา: `⏰ วิธีจัดการเวลากินยา
━━━━━━━━━━━━━━━━━━━
🔹 ดูเวลา: เวลากินยา

🔹 เพิ่มเวลา:
เพิ่มเวลากินยา [เวลา]
ตัวอย่าง: เพิ่มเวลากินยา 12:00

🔹 ลบเวลา:
ลบเวลากินยา [เลข]`,

    กินยา: `✅ วิธีบันทึกการกินยา
━━━━━━━━━━━━━━━━━━━
🟢 กินตรงเวลา:
กินยา [เลขเวลา]

🟡 กินช้า (เกิน 30 นาที):
1. พิมพ์ "กินยาช้า"
2. พิมพ์ "กินยาช้า [เลข]"`,
  };

  const text =
    helps[topic] ||
    `❓ ไม่พบหัวข้อ "${topic}"

📚 หัวข้อที่มี:
• help ลงทะเบียน
• help เพิ่มยา
• help เติมยา
• help ยกเลิกยา
• help ดูยา
• help เวลากินยา
• help กินยา`;

  return await reply(replyToken, text);
}

// ==================== Register ====================
async function handleRegister(replyToken, text, lineUserId) {
  const odotId = text.replace("ลงทะเบียน ", "").trim();

  const existing = await getUser(lineUserId);
  if (existing) {
    return await reply(
      replyToken,
      `❌ คุณลงทะเบียนแล้วค่ะ\n📋 รหัสผู้ป่วย: ${existing.odotId}`
    );
  }

  const newUser = {
    odotId,
    lineUserId,
    drugs: [],
    reminderTimes: ["08:00", "20:00"],
    createdAt: new Date().toISOString(),
  };

  await saveUser(lineUserId, newUser);

  return await reply(
    replyToken,
    `✅ ลงทะเบียนสำเร็จ!
━━━━━━━━━━━━━━━━━━━
📋 รหัสผู้ป่วย: ${odotId}
⏰ เวลาเตือน: 08:00, 20:00

💡 ขั้นตอนต่อไป:
พิมพ์: เพิ่มยา [ชื่อยา] [จำนวน]`
  );
}

// ==================== Add Drug ====================
async function handleAddDrug(replyToken, text, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) {
    return await reply(
      replyToken,
      `❌ กรุณาลงทะเบียนก่อนค่ะ\n\nพิมพ์: ลงทะเบียน [รหัสผู้ป่วย]`
    );
  }

  const parts = text.replace("เพิ่มยา ", "").trim().split(" ");
  if (parts.length < 2) {
    return await reply(
      replyToken,
      `❌ รูปแบบไม่ถูกต้องค่ะ\n\nพิมพ์: เพิ่มยา [ชื่อยา] [จำนวน]\nตัวอย่าง: เพิ่มยา พาราเซตามอล 30`
    );
  }

  const quantity = parseInt(parts.pop());
  const name = parts.join(" ");

  if (isNaN(quantity) || quantity <= 0) {
    return await reply(replyToken, `❌ จำนวนต้องเป็นตัวเลขมากกว่า 0 ค่ะ`);
  }

  user.drugs.push({ name, quantity });
  await saveUser(lineUserId, user);

  return await reply(
    replyToken,
    `✅ เพิ่มยาสำเร็จ!\n━━━━━━━━━━━━━━━━━━━\n💊 ยา: ${name}\n📦 จำนวน: ${quantity} เม็ด`
  );
}

// ==================== Show Drugs ====================
async function handleShowDrugs(replyToken, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) {
    return await reply(replyToken, `❌ กรุณาลงทะเบียนก่อนค่ะ`);
  }

  if (user.drugs.length === 0) {
    return await reply(
      replyToken,
      `📋 ยังไม่มียาในระบบค่ะ\n\nเพิ่มยา: เพิ่มยา [ชื่อยา] [จำนวน]`
    );
  }

  let list = `📋 รายการยาของคุณ:\n━━━━━━━━━━━━━━━━━━━\n`;

  user.drugs.forEach((drug, i) => {
    let icon = "✅";
    let note = "";

    if (drug.quantity <= 0) {
      icon = "🚫";
      note = " → หมดแล้ว!";
    } else if (drug.quantity <= 5) {
      icon = "🔴";
      note = " → ใกล้หมด!";
    } else if (drug.quantity <= 10) {
      icon = "🟡";
      note = " → เหลือน้อย";
    }

    list += `\n${i + 1}. ${icon} ${drug.name}\n   📦 ${drug.quantity} เม็ด${note}\n`;
  });

  list += `\n💡 คำสั่งที่เกี่ยวข้อง:\n• เติมยา - เติมจำนวนยา\n• ยกเลิกยา - ลบยา`;

  return await reply(replyToken, list);
}

// ==================== Refill Drug ====================
async function handleRefillStart(replyToken, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user || user.drugs.length === 0) {
    return await reply(replyToken, `❌ ยังไม่มียาในระบบค่ะ`);
  }

  let list = `📦 เลือกยาที่ต้องการเติม:\n━━━━━━━━━━━━━━━━━━━\n`;

  user.drugs.forEach((drug, i) => {
    let icon = "";
    if (drug.quantity <= 0) icon = " 🚫";
    else if (drug.quantity <= 5) icon = " 🔴";
    else if (drug.quantity <= 10) icon = " 🟡";

    list += `${i + 1}. ${drug.name} (${drug.quantity} เม็ด)${icon}\n`;
  });

  list += `\n📝 พิมพ์: เติมยา [เลข] [จำนวน]\nตัวอย่าง: เติมยา 1 30`;

  return await reply(replyToken, list);
}

async function handleRefill(replyToken, text, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) return;

  const parts = text.replace("เติมยา ", "").trim().split(" ");
  if (parts.length < 2) {
    return await reply(
      replyToken,
      `❌ รูปแบบไม่ถูกต้องค่ะ\n\nพิมพ์: เติมยา [เลข] [จำนวน]`
    );
  }

  const index = parseInt(parts[0]) - 1;
  const qty = parseInt(parts[1]);

  if (isNaN(index) || isNaN(qty) || qty <= 0) {
    return await reply(replyToken, `❌ ตัวเลขไม่ถูกต้องค่ะ`);
  }

  if (index < 0 || index >= user.drugs.length) {
    return await reply(replyToken, `❌ ไม่พบยาหมายเลขนี้ค่ะ`);
  }

  user.drugs[index].quantity += qty;
  await saveUser(lineUserId, user);

  return await reply(
    replyToken,
    `✅ เติมยาสำเร็จ!\n━━━━━━━━━━━━━━━━━━━\n💊 ยา: ${user.drugs[index].name}\n📦 รวมทั้งหมด: ${user.drugs[index].quantity} เม็ด`
  );
}

// ==================== Cancel Drug ====================
async function handleCancelStart(replyToken, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user || user.drugs.length === 0) {
    return await reply(replyToken, `❌ ยังไม่มียาในระบบค่ะ`);
  }

  let list = `🗑️ เลือกยาที่ต้องการลบ:\n━━━━━━━━━━━━━━━━━━━\n`;
  user.drugs.forEach((drug, i) => {
    list += `${i + 1}. ${drug.name} (${drug.quantity} เม็ด)\n`;
  });
  list += `\n📝 พิมพ์: ยกเลิกยา [เลข]\n⚠️ ลบแล้วไม่สามารถกู้คืนได้`;

  return await reply(replyToken, list);
}

async function handleCancel(replyToken, text, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) return;

  const index = parseInt(text.replace("ยกเลิกยา ", "").trim()) - 1;

  if (isNaN(index) || index < 0 || index >= user.drugs.length) {
    return await reply(replyToken, `❌ ไม่พบยาหมายเลขนี้ค่ะ`);
  }

  const drug = user.drugs[index];

  userStates[lineUserId] = {
    action: "confirmCancel",
    drugIndex: index,
  };

  return await reply(
    replyToken,
    `⚠️ ยืนยันการลบยา\n━━━━━━━━━━━━━━━━━━━\n💊 ยา: ${drug.name}\n📦 คงเหลือ: ${drug.quantity} เม็ด\n\n✅ พิมพ์ "ยืนยัน" หรือ "ใช่" เพื่อลบ\n❌ พิมพ์อย่างอื่นเพื่อยกเลิก`
  );
}

// ==================== Reminder Times ====================
async function handleShowTimes(replyToken, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) {
    return await reply(replyToken, `❌ กรุณาลงทะเบียนก่อนค่ะ`);
  }

  const times = user.reminderTimes || ["08:00", "20:00"];

  let list = `⏰ เวลากินยาของคุณ:\n━━━━━━━━━━━━━━━━━━━\n`;
  times.forEach((t, i) => {
    list += `${i + 1}. 🕐 ${t} น.\n`;
  });
  list += `\n💡 คำสั่งที่เกี่ยวข้อง:\n• เพิ่มเวลากินยา [เวลา]\n• ลบเวลากินยา [เลข]`;

  return await reply(replyToken, list);
}

async function handleAddTime(replyToken, text, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) return;

  let time = text.replace("เพิ่มเวลากินยา ", "").trim().replace(".", ":");

  const parts = time.split(":");
  if (parts.length === 2) {
    time = `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
  }

  const regex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
  if (!regex.test(time)) {
    return await reply(
      replyToken,
      `❌ รูปแบบเวลาไม่ถูกต้องค่ะ\n\nตัวอย่าง: เพิ่มเวลากินยา 12:00`
    );
  }

  if (!user.reminderTimes) user.reminderTimes = ["08:00", "20:00"];

  if (user.reminderTimes.includes(time)) {
    return await reply(replyToken, `❌ มีเวลา ${time} อยู่แล้วค่ะ`);
  }

  user.reminderTimes.push(time);
  user.reminderTimes.sort();
  await saveUser(lineUserId, user);

  const timeList = user.reminderTimes
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");

  return await reply(
    replyToken,
    `✅ เพิ่มเวลาสำเร็จ!\n━━━━━━━━━━━━━━━━━━━\n⏰ เวลาใหม่: ${time} น.\n\n📋 เวลากินยาทั้งหมด:\n${timeList}`
  );
}

async function handleRemoveTime(replyToken, text, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) return;

  const index = parseInt(text.replace("ลบเวลากินยา ", "").trim()) - 1;
  const times = user.reminderTimes || ["08:00", "20:00"];

  if (isNaN(index) || index < 0 || index >= times.length) {
    return await reply(replyToken, `❌ ไม่พบเวลาหมายเลขนี้ค่ะ`);
  }

  if (times.length <= 1) {
    return await reply(
      replyToken,
      `❌ ไม่สามารถลบได้ค่ะ\nต้องมีเวลากินยาอย่างน้อย 1 เวลา`
    );
  }

  const removed = times[index];
  user.reminderTimes.splice(index, 1);
  await saveUser(lineUserId, user);

  return await reply(
    replyToken,
    `✅ ลบเวลา ${removed} แล้วค่ะ\n\n📋 เวลาที่เหลือ:\n${user.reminderTimes.join("\n")}`
  );
}

// ==================== Take Drug ====================
async function handleLateStart(replyToken, lineUserId) {
  const user = await getUser(lineUserId);
  if (!user) return;

  const times = user.reminderTimes || ["08:00", "20:00"];

  let list = `⏰ เลือกเวลาที่กินยาช้า:\n━━━━━━━━━━━━━━━━━━━\n`;
  times.forEach((t, i) => {
    list += `${i + 1}. 🕐 ${t} น.\n`;
  });
  list += `\n📝 พิมพ์: กินยาช้า [เลข]\nตัวอย่าง: กินยาช้า 1`;

  return await reply(replyToken, list);
}

async function handleTakeDrug(replyToken, text, lineUserId, isLate) {
  const user = await getUser(lineUserId);
  if (!user) {
    return await reply(replyToken, `❌ กรุณาลงทะเบียนก่อนค่ะ`);
  }

  const cmd = isLate ? "กินยาช้า " : "กินยา ";
  const index = parseInt(text.replace(cmd, "").trim()) - 1;
  const times = user.reminderTimes || ["08:00", "20:00"];

  if (isNaN(index) || index < 0 || index >= times.length) {
    return await reply(replyToken, `❌ ไม่พบเวลาหมายเลขนี้ค่ะ`);
  }

  if (user.drugs.length === 0) {
    return await reply(replyToken, `❌ ยังไม่มียาในระบบค่ะ`);
  }

  let status = "";
  user.drugs.forEach((drug) => {
    if (drug.quantity > 0) {
      drug.quantity -= 1;

      let icon = "💊";
      if (drug.quantity <= 0) icon = "🚫";
      else if (drug.quantity <= 5) icon = "🔴";
      else if (drug.quantity <= 10) icon = "🟡";

      status += `${icon} ${drug.name}: เหลือ ${drug.quantity} เม็ด\n`;
    } else {
      status += `🚫 ${drug.name}: หมดแล้ว!\n`;
    }
  });

  await saveUser(lineUserId, user);

  const lateText = isLate ? " (กินช้า)" : "";
  const now = new Date();
  const dateStr = now.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return await reply(
    replyToken,
    `✅ บันทึกการกินยาสำเร็จ!${lateText}\n━━━━━━━━━━━━━━━━━━━\n⏰ เวลากินยา: ${times[index]} น.\n📅 วันที่: ${dateStr}\n\n📊 สถานะยาหลังกิน:\n${status}`
  );
}

// ==================== Webhook ====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
});

app.get("/", (req, res) => {
  res.send("🏥 Medicine LINE Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startReminderSystem();
});