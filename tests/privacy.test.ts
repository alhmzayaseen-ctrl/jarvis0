import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSensitiveContent } from "../src/privacy";

test("detects credentials and health disclosures in English, Dutch, and Arabic", () => {
  const sensitiveExamples = [
    "My password is example-secret",
    "I have diabetes",
    "I was diagnosed with an example condition",
    "Mijn API-sleutel: voorbeeld-token",
    "Ik heb diabetes",
    "كلمة المرور: مثال-سري",
    "أعاني من السكري",
  ];

  for (const example of sensitiveExamples) {
    assert.equal(containsSensitiveContent(example), true, example);
  }
});

test("detects sensitive identifiers and personal data", () => {
  const sensitiveExamples = [
    "Contact me at user@example.com",
    "Mijn burgerservicenummer staat in dit bericht",
    "ما رقم الهوية الوطنية؟",
  ];

  for (const example of sensitiveExamples) {
    assert.equal(containsSensitiveContent(example), true, example);
  }
});

test("detects local phone numbers in English, Dutch, and Arabic", () => {
  const sensitiveExamples = [
    "My phone number is (202) 555-0142",
    "Mijn mobiele nummer is 06-1234 5678",
    "رقم هاتفي: 050 123 4567",
    "رقم الجوال (٠٥٠) ١٢٣-٤٥٦٧",
  ];

  for (const example of sensitiveExamples) {
    assert.equal(containsSensitiveContent(example), true, example);
  }
});

test("detects Arabic sensitive terms with diacritics and alef variants", () => {
  const sensitiveExamples = [
    "أعاني من السُّكري",
    "أعراض المرض واضحة",
    "اعراض المرض واضحة",
    "أنا حامل",
    "أعاني من مشاكل في الحمل",
    "اختبار الحمل إيجابي",
  ];

  for (const example of sensitiveExamples) {
    assert.equal(containsSensitiveContent(example), true, example);
  }
});

test("detects Arabic credentials despite repeated spaces and punctuation", () => {
  const sensitiveExamples = [
    "كلمة   المرور: مثال-سري",
    "كلمة المرور ، مثال-سري",
  ];

  for (const example of sensitiveExamples) {
    assert.equal(containsSensitiveContent(example), true, example);
  }
});

test("does not classify ordinary messages or contextual mentions as disclosures", () => {
  const ordinaryExamples = [
    "Please explain photosynthesis.",
    "The appointment is on 2026-11-01.",
    "There are 12,345 records in the report.",
    "The reference code is 123-456-7890.",
    "Bestelnummer: 06-1234 5678.",
    "رقم الطلب: 050 123 4567.",
    "My phone number is 12345.",
    "Ik wil een nieuw wachtwoordveld ontwerpen.",
    "أدرس في الجامعة اليوم.",
    "This article discusses public health and financial policy.",
    "We bespreken gezondheidszorg en financieel beleid.",
    "نناقش الصحة العامة والسياسة المالية.",
    "هذا يوم طبيعي وجميل.",
    "تحمل المسؤولية أمر مهم.",
    "حمل الحقيبة إلى السيارة كان متعباً.",
    "نتحدث عن المرض في الأدب بشكل عام.",
    "هذا طبيعي، وتحمّل الفريق مسؤولية المهمة.",
  ];

  for (const example of ordinaryExamples) {
    assert.equal(containsSensitiveContent(example), false, example);
  }
});
