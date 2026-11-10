// Ported from the partner's packages/core/src/region. Keep the two in step.
export const COUNTRIES = [
  "PK",
  "GB"
];
export const REGIONS = {
  PK: {
    name: "Pakistan",
    currency: "PKR",
    timezone: "Asia/Karachi",
    taxProfile: "pk_pra",
    paymentProvider: "in_person",
    opensIn: null,
    launch: null,
    phone: {
      pattern: /^\+923\d{9}$/,
      example: "0312 1234567"
    },
    cities: [
      "Rawalpindi",
      "Lahore",
      "Faisalabad",
      "Multan",
      "Gujranwala",
      "Sialkot",
      "Sargodha",
      "Bahawalpur"
    ]
  },
  GB: {
    name: "United Kingdom",
    currency: "GBP",
    timezone: "Europe/London",
    taxProfile: "gb_vat",
    paymentProvider: "stripe_connect",
    opensIn: null,
    launch: "April 2027",
    phone: {
      pattern: /^\+447\d{9}$/,
      example: "07700 900123"
    },
    cities: [
      "London",
      "Birmingham",
      "Manchester",
      "Bradford",
      "Leicester",
      "Glasgow",
      "Leeds",
      "Luton"
    ]
  }
};
export const TAX_PROFILE_LABELS = {
  pk_pra: "PRA (Punjab)",
  gb_vat: "UK VAT"
};
export const isOpen = (country)=>REGIONS[country].opensIn === null;
export function normalizePhone(value, country) {
  const digits = value.replace(/[\s\-()]/g, "");
  const code = country === "PK" ? "92" : "44";
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith(code)) return `+${digits}`;
  if (digits.startsWith("0")) return `+${code}${digits.slice(1)}`;
  return digits;
}
export const isMobile = (value, country)=>REGIONS[country].phone.pattern.test(normalizePhone(value, country));
export function formatPhone(value, country) {
  const n = normalizePhone(value, country);
  const pk = /^\+92(3\d{2})(\d{7})$/.exec(n);
  if (pk) return `+92 ${pk[1]} ${pk[2]}`;
  const gb = /^\+44(7\d{3})(\d{6})$/.exec(n);
  if (gb) return `+44 ${gb[1]} ${gb[2]}`;
  return value.trim();
}
