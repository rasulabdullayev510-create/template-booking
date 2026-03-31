const express = require("express");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const twilio = require("twilio");
const crypto = require("crypto");
const path = require("path");
const cron = require("node-cron");
const cors = require("cors");
const CONFIG = require("./config");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const adapter = new FileSync("db.json");
const db = low(adapter);
db.defaults({ bookings: [], feedback: [], walkins: [], pageviews: [] }).write();

const {
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
  PORT = 3000,
  ADMIN_PASSWORD = "admin2024",
  OWNER_PHONE,
} = process.env;

const BUSINESS_NAME    = CONFIG.businessName;
const BOOKING_PAGE_URL = CONFIG.bookingPageUrl;
const GOOGLE_REVIEW    = CONFIG.googleReviewLink;
const SERVICES         = CONFIG.services;
const HOURS            = CONFIG.hours;
const REVIEW_DELAY_MIN = CONFIG.reviewDelayMinutes || 1440;

const twilioClient = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function generateToken() { return crypto.randomBytes(16).toString("hex"); }
function generateShortId() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function getSurveyUrl(token) { return `${BOOKING_PAGE_URL}/review?token=${token}`; }

function formatTime(t) {
  const [h, m] = t.split(":");
  const hr = parseInt(h);
  return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? "PM" : "AM"}`;
}

async function sendSMS(to, body) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] ${body.slice(0, 80)}`); return; }
  await twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to });
}

async function sendOwnerRequest(booking) {
  if (!OWNER_PHONE) return;
  await sendSMS(OWNER_PHONE,
    `New booking request!\n${booking.customerName} wants ${booking.serviceName}\n${booking.date} at ${formatTime(booking.time)}\nPhone: ${booking.phone}\n\nReply YES to confirm or NO to decline.`
  );
}

async function sendCustomerConfirmation(booking) {
  await sendSMS(booking.phone,
    `Hi ${booking.customerName}! Your booking is confirmed at ${BUSINESS_NAME}. ${booking.serviceName} on ${booking.date} at ${formatTime(booking.time)}. See you then!`
  );
}

async function sendCustomerDenied(booking) {
  await sendSMS(booking.phone,
    `Hi ${booking.customerName}, unfortunately that time is no longer available at ${BUSINESS_NAME}. Please choose another time: ${BOOKING_PAGE_URL}/book`
  );
}

async function sendCustomerOffer(booking, suggestedDate, suggestedTime) {
  await sendSMS(booking.phone,
    `Hi ${booking.customerName}! That time isn't available. Would ${suggestedDate} at ${formatTime(suggestedTime)} work instead?\n\nReply YES to confirm or NO to decline.`
  );
}

async function sendReviewSMS(phone, customerName, token) {
  await sendSMS(phone,
    `Hi ${customerName}! How was your experience at ${BUSINESS_NAME}? Takes 20 seconds: ${getSurveyUrl(token)}`
  );
}

// ── API ───────────────────────────────────────────────────────

app.get("/api/info", (req, res) => {
  res.json({ businessName: BUSINESS_NAME, googleReviewLink: GOOGLE_REVIEW });
});

// Website visit tracking
app.post("/api/track", (req, res) => {
  const { page } = req.body;
  db.get("pageviews").push({
    page: page || "unknown",
    date: new Date().toISOString().split("T")[0],
    ts: new Date().toISOString(),
  }).write();
  res.json({ ok: true });
});

app.get("/api/stats", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const pageviews = db.get("pageviews").value();
  const bookings  = db.get("bookings").value();
  const walkins   = db.get("walkins").value();
  const feedback  = db.get("feedback").value();
  const confirmed = bookings.filter(b => b.status === "confirmed");

  // Last 30 days views by day
  const last30 = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last30[d.toISOString().split("T")[0]] = 0;
  }
  pageviews.forEach(v => { if (last30[v.date] !== undefined) last30[v.date]++; });

  // Upcoming bookings (next 14 days, confirmed)
  const today = new Date().toISOString().split("T")[0];
  const upcoming = confirmed
    .filter(b => b.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    .slice(0, 20);

  const totalViews = pageviews.length;
  const homeViews  = pageviews.filter(v => v.page === "home").length;
  const convRate   = homeViews ? ((confirmed.length / homeViews) * 100).toFixed(1) : "0.0";

  const revenue = confirmed.reduce((s, b) => s + b.servicePrice, 0);
  const avgRating = feedback.length
    ? (feedback.reduce((s, f) => s + f.rating, 0) / feedback.length).toFixed(1) : null;

  res.json({
    totalViews, homeViews, convRate,
    totalBookings: confirmed.length,
    totalRevenue: revenue,
    avgRating,
    reviewRate: confirmed.length ? Math.round((feedback.length / confirmed.length) * 100) : 0,
    totalWalkins: walkins.length,
    viewsByDay: last30,
    upcoming,
  });
});

app.get("/api/services", (req, res) => res.json(SERVICES));

app.get("/api/availability", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });

  const d = new Date(date);
  const day = d.getDay();
  const closed = (HOURS.closedDays || []).includes(day);
  if (closed) return res.json({ date, slots: [] });

  let h;
  if (day === 5) h = HOURS.friday || HOURS.default;
  else if (day === 0 || day === 6) h = HOURS.weekend || HOURS.default;
  else h = HOURS.default;

  const startH = h.startHour, endH = h.endHour;
  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const todayStr = now.toISOString().split("T")[0];

  const booked = db.get("bookings")
    .filter(b => b.date === date && b.status !== "cancelled" && b.status !== "denied")
    .map(b => b.time).value();

  const slots = [];
  for (let hr = startH; hr <= endH; hr++) {
    for (let m of [0, 30]) {
      if (hr === endH && m === 30) continue;
      const timeStr = String(hr).padStart(2, "0") + ":" + String(m).padStart(2, "0");
      if (date === todayStr) {
        const slotTime = new Date(date + "T" + timeStr + ":00");
        if (slotTime < oneHourFromNow) continue;
      }
      slots.push({ time: timeStr, status: booked.includes(timeStr) ? "booked" : "available" });
    }
  }
  res.json({ date, slots });
});

app.post("/api/bookings", async (req, res) => {
  const { serviceId, serviceName, servicePrice, date, time, customerName, email, notes } = req.body;
  let phone = (req.body.phone || "").toString().replace(/[^0-9+]/g, "");
  if (phone.length === 10) phone = "+1" + phone;
  else if (phone.length === 11 && phone[0] === "1") phone = "+" + phone;
  else if (phone.length > 0 && !phone.startsWith("+")) phone = "+" + phone;
  if (!serviceId || !date || !time || !customerName || !phone)
    return res.status(400).json({ error: "Missing required fields" });

  const taken = db.get("bookings")
    .find(b => b.date === date && b.time === time && b.status !== "cancelled" && b.status !== "denied")
    .value();
  if (taken) return res.status(409).json({ error: "Slot already booked" });

  const booking = {
    id: `BK-${Date.now()}`, shortId: generateShortId(),
    serviceId, serviceName: serviceName || serviceId,
    servicePrice: Number(servicePrice) || 0,
    date, time, customerName, phone,
    email: email || null, notes: notes || null,
    status: "pending",
    reviewToken: generateToken(), reviewSentAt: null,
    createdAt: new Date().toISOString(),
  };

  db.get("bookings").push(booking).write();
  console.log(`✓ Booking: ${booking.id} — ${customerName} for ${booking.serviceName} on ${date} at ${time}`);

  try { await sendOwnerRequest(booking); }
  catch (err) { console.error(`✗ Owner SMS:`, err.message); }

  res.json({
    success: true, bookingId: booking.id,
    booking: { id: booking.id, serviceName: booking.serviceName, date, time, price: booking.servicePrice, customerName },
  });
});

// ── Walk-in customers (manual review follow-up) ──────────────

// Add a walk-in customer — they get a review SMS after REVIEW_DELAY_MIN
app.post("/api/walkins", async (req, res) => {
  const { customerName, serviceName } = req.body;
  let phone = (req.body.phone || "").toString().replace(/[^0-9+]/g, "");
  if (phone.length === 10) phone = "+1" + phone;
  else if (phone.length === 11 && phone[0] === "1") phone = "+" + phone;
  else if (phone.length > 0 && !phone.startsWith("+")) phone = "+" + phone;
  if (!customerName || !phone) return res.status(400).json({ error: "Name and phone required" });

  const walkin = {
    id: `WK-${Date.now()}`,
    customerName, phone,
    serviceName: serviceName || "Service",
    reviewToken: generateToken(),
    reviewSentAt: null,
    createdAt: new Date().toISOString(),
  };

  db.get("walkins").push(walkin).write();
  console.log(`✓ Walk-in added: ${customerName} (${phone})`);
  res.json({ success: true, id: walkin.id });
});

app.get("/api/walkins", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("walkins").value().reverse());
});

// ── SMS webhook ───────────────────────────────────────────────

app.post("/api/sms-webhook", async (req, res) => {
  const from = req.body.From;
  const bodyRaw = (req.body.Body || "").trim();
  const body = bodyRaw.toUpperCase();

  const ownerNorm = (OWNER_PHONE || "").replace(/[^0-9]/g, "");
  const fromNorm  = (from || "").replace(/[^0-9]/g, "");
  const isOwner   = ownerNorm && fromNorm.endsWith(ownerNorm.slice(-10));

  if (isOwner) {
    const pendingBooking = db.get("bookings").filter({ status: "pending" }).sortBy("createdAt").last().value();
    const awaitingOffer  = db.get("bookings").filter({ status: "denied_awaiting_offer" }).sortBy("createdAt").last().value();
    const dateTimeMatch  = bodyRaw.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);

    if (body === "YES" && pendingBooking) {
      db.get("bookings").find({ id: pendingBooking.id }).assign({ status: "confirmed" }).write();
      try { await sendCustomerConfirmation(pendingBooking); }
      catch (err) { console.error(err.message); }

    } else if (body === "NO" && pendingBooking) {
      db.get("bookings").find({ id: pendingBooking.id }).assign({ status: "denied_awaiting_offer" }).write();
      try {
        await sendSMS(OWNER_PHONE,
          `Declined ${pendingBooking.customerName}. Suggest a new time?\n\nReply with date+time like:\n03/29 14:00\n\nOr reply SKIP to send them a rebook link.`
        );
      } catch (err) { console.error(err.message); }

    } else if (body === "SKIP" && awaitingOffer) {
      db.get("bookings").find({ id: awaitingOffer.id }).assign({ status: "denied" }).write();
      try { await sendCustomerDenied(awaitingOffer); }
      catch (err) { console.error(err.message); }

    } else if (dateTimeMatch && awaitingOffer) {
      const now = new Date();
      const suggestedDate = `${now.getFullYear()}-${dateTimeMatch[1].padStart(2,"0")}-${dateTimeMatch[2].padStart(2,"0")}`;
      const suggestedTime = `${dateTimeMatch[3].padStart(2,"0")}:${dateTimeMatch[4]}`;
      db.get("bookings").find({ id: awaitingOffer.id }).assign({ status: "offer_sent", suggestedDate, suggestedTime }).write();
      try { await sendCustomerOffer(awaitingOffer, suggestedDate, suggestedTime); }
      catch (err) { console.error(err.message); }
    }

  } else {
    const fromN = (from || "").replace(/[^0-9]/g, "");
    const allOffers = db.get("bookings").filter(b => b.status === "offer_sent").value();
    const offerBooking = allOffers.find(b => (b.phone || "").replace(/[^0-9]/g, "").endsWith(fromN.slice(-10)));

    if (offerBooking) {
      if (body === "YES") {
        const taken = db.get("bookings")
          .find(b => b.date === offerBooking.suggestedDate && b.time === offerBooking.suggestedTime
            && b.status !== "cancelled" && b.status !== "denied" && b.id !== offerBooking.id)
          .value();
        if (taken) {
          db.get("bookings").find({ id: offerBooking.id }).assign({ status: "denied" }).write();
          try { await sendSMS(offerBooking.phone, `Sorry ${offerBooking.customerName}, that time just got taken. Please rebook: ${BOOKING_PAGE_URL}/book`); }
          catch (err) { console.error(err.message); }
        } else {
          db.get("bookings").find({ id: offerBooking.id }).assign({ status: "confirmed", date: offerBooking.suggestedDate, time: offerBooking.suggestedTime }).write();
          const updated = db.get("bookings").find({ id: offerBooking.id }).value();
          try { await sendCustomerConfirmation(updated); }
          catch (err) { console.error(err.message); }
        }
      } else if (body === "NO") {
        db.get("bookings").find({ id: offerBooking.id }).assign({ status: "denied" }).write();
        try { await sendSMS(offerBooking.phone, `No problem ${offerBooking.customerName}! Give us a call and we'll find a time that works.`); }
        catch (err) { console.error(err.message); }
      }
    }
  }

  res.set("Content-Type", "text/xml").send("<Response></Response>");
});

// ── Review endpoints ──────────────────────────────────────────

app.get("/api/bookings", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("bookings").value().reverse());
});

app.post("/api/review", (req, res) => {
  const { token, rating, comment } = req.body;
  if (!token || !rating) return res.status(400).json({ error: "token and rating required" });

  // Check bookings first, then walkins
  const booking = db.get("bookings").find({ reviewToken: token }).value();
  const walkin  = !booking ? db.get("walkins").find({ reviewToken: token }).value() : null;
  const record  = booking || walkin;
  if (!record) return res.status(404).json({ error: "Invalid token" });

  db.get("feedback").push({
    id: Date.now(),
    source: booking ? "booking" : "walkin",
    sourceId: record.id,
    customerName: record.customerName,
    serviceName: record.serviceName,
    rating: Number(rating), comment: comment || null,
    submittedAt: new Date().toISOString(),
  }).write();

  res.json({ success: true, redirectToGoogle: Number(rating) >= 4 });
});

app.get("/api/review/:token", (req, res) => {
  const booking = db.get("bookings").find({ reviewToken: req.params.token }).value();
  const walkin  = !booking ? db.get("walkins").find({ reviewToken: req.params.token }).value() : null;
  const record  = booking || walkin;
  if (!record) return res.status(404).json({ error: "Not found" });
  const alreadyReviewed = db.get("feedback").find({ sourceId: record.id }).value();
  res.json({ customerName: record.customerName, serviceName: record.serviceName, alreadyReviewed: !!alreadyReviewed });
});

app.get("/api/analytics", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const bookings = db.get("bookings").value();
  const feedback = db.get("feedback").value();
  const walkins  = db.get("walkins").value();
  const confirmed = bookings.filter(b => b.status === "confirmed");
  const revenue = confirmed.reduce((sum, b) => sum + b.servicePrice, 0);
  const byService = {};
  confirmed.forEach(b => { byService[b.serviceName] = (byService[b.serviceName] || 0) + 1; });
  const last14 = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last14[d.toISOString().split("T")[0]] = 0;
  }
  confirmed.forEach(b => { if (last14[b.date] !== undefined) last14[b.date] += b.servicePrice; });
  const byHour = {};
  confirmed.forEach(b => { const hr = b.time.split(":")[0]; byHour[hr] = (byHour[hr] || 0) + 1; });
  const totalFeedback = feedback.length;
  const avgRating = totalFeedback ? (feedback.reduce((s, f) => s + f.rating, 0) / totalFeedback).toFixed(1) : null;
  const reviewRate = confirmed.length ? Math.round((totalFeedback / confirmed.length) * 100) : 0;
  res.json({ totalBookings: confirmed.length, totalRevenue: revenue, avgRating, reviewRate, byService, revenueByDay: last14, byHour, totalWalkins: walkins.length });
});

// ── Static pages ──────────────────────────────────────────────

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/review",    (req, res) => res.sendFile(path.join(__dirname, "public", "review.html")));
app.get("*",          (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Cron: review SMS for bookings + walkins ───────────────────

cron.schedule("* * * * *", async () => {
  const now = new Date();

  // Confirmed bookings
  const pendingBookings = db.get("bookings").filter(b => {
    if (b.status !== "confirmed" || b.reviewSentAt) return false;
    const apptTime = new Date(`${b.date}T${b.time}:00-06:00`);
    return (now - apptTime) / (1000 * 60) >= REVIEW_DELAY_MIN;
  }).value();

  for (const b of pendingBookings) {
    try {
      await sendReviewSMS(b.phone, b.customerName, b.reviewToken);
      db.get("bookings").find({ id: b.id }).assign({ reviewSentAt: now.toISOString() }).write();
      console.log(`✓ Review SMS → ${b.customerName} (booking)`);
    } catch (err) { console.error(`✗ Review SMS failed:`, err.message); }
  }

  // Walk-ins
  const pendingWalkins = db.get("walkins").filter(w => {
    if (w.reviewSentAt) return false;
    const createdTime = new Date(w.createdAt);
    return (now - createdTime) / (1000 * 60) >= REVIEW_DELAY_MIN;
  }).value();

  for (const w of pendingWalkins) {
    try {
      await sendReviewSMS(w.phone, w.customerName, w.reviewToken);
      db.get("walkins").find({ id: w.id }).assign({ reviewSentAt: now.toISOString() }).write();
      console.log(`✓ Review SMS → ${w.customerName} (walk-in)`);
    } catch (err) { console.error(`✗ Review SMS failed:`, err.message); }
  }
});

app.listen(PORT, () => {
  console.log(`\n✓  ${BUSINESS_NAME} — Booking + Review System`);
  console.log(`   Booking:   http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard\n`);
});
