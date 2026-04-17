// ================================================================
//  CLIENT CONFIG — EDIT THIS FILE FOR EACH NEW CLIENT
//  Then deploy the booking/ folder to Railway
// ================================================================
module.exports = {

  // --- Business info ---
  businessName:     "Apex Auto Detailing",
  bookingPageUrl:   "https://template-booking.onrender.com",
  googleReviewLink: "https://g.page/apex-auto-detailing-calgary",

  // --- Operating hours ---
  // startHour / endHour are 24h format integers (9 = 9am, 17 = 5pm)
  // closedDays: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  hours: {
    default:     { startHour: 8,  endHour: 18 },  // Mon–Fri
    friday:      { startHour: 8,  endHour: 18 },  // Friday
    weekend:     { startHour: 8,  endHour: 17 },  // Sat (Sun opens at 10 but server uses startHour)
    closedDays:  [],
  },

  // --- Services shown on booking page ---
  services: [
    {
      id:          "full-detail",
      name:        "Full Detail",
      description: "Complete interior + exterior. Vacuum, shampoo, clay bar, wax.",
      duration:    240,
      price:       200,
      category:   "package",
    },
    {
      id:          "interior-detail",
      name:        "Interior Detail",
      description: "Deep vacuum, steam clean, leather condition, full wipe-down.",
      duration:    150,
      price:       120,
      category:   "package",
    },
    {
      id:          "exterior-wash-wax",
      name:        "Exterior Wash & Wax",
      description: "Hand wash, clay bar, and carnauba wax. Showroom shine.",
      duration:    120,
      price:       100,
      category:   "package",
    },
    {
      id:          "paint-correction-1",
      name:        "Paint Correction (1-Stage)",
      description: "Machine polish to remove swirl marks and light scratches.",
      duration:    240,
      price:       250,
      category:   "paint",
    },
    {
      id:          "ceramic-coating",
      name:        "Ceramic Coating",
      description: "Long-term paint protection. Repels water, dirt, and UV.",
      duration:    300,
      price:       600,
      category:   "protection",
    },
    {
      id:          "engine-bay",
      name:        "Engine Bay Clean",
      description: "Safe degreasing and detailing of your engine bay.",
      duration:    90,
      price:       80,
      category:   "addon",
    },
  ],

  // --- Timezone ---
  // IANA timezone string for appointment time calculations (review SMS fires 24h after appt)
  // Examples: "America/Edmonton", "America/Vancouver", "America/Toronto", "America/New_York"
  timezone: "America/Edmonton",

  // --- Review SMS delay ---
  // How many minutes after the appointment time to send the review SMS
  reviewDelayMinutes: 1440,  // 1440 = 24 hours (use 2 for testing)
};
