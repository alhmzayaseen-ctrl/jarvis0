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

test("detects cloud credentials, API tokens, and private keys", () => {
  const secretExamples = [
    "Deploy using AKIAIOSFODNN7EXAMPLE today",
    "Here is the token: ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
    "Use gho_1234567890abcdefghijklmnopqrstuvwxyzAB for oauth",
    "github_pat_11AAAAAAA01234567890abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ab",
    "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBAgwggQEAgEAAoIBAQC...\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAz...",
    "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI...",
  ];

  for (const example of secretExamples) {
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
    "My phone number is 123456789012345678 and my cell is (202) 555-0142",
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
    "The project was inspired by AKIA principles of architecture.",
    "Here is the github repo name: my-project-ghp-tools.",
    "The SSH public key is ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC...",
    "Check out https://github.com/org/repo for details.",
  ];

  for (const example of ordinaryExamples) {
    assert.equal(containsSensitiveContent(example), false, example);
  }
});

test("P-1 regression: eliminates technical false positives while preserving sensitive personal and credential detections", () => {
  const technicalNonSensitiveExamples = [
    "Fix the race condition in lock acquisition",
    "Resolve data race and stale-lock race in SQLite writer",
    "Prevent API rate limit abuse in production",
    "Add quota abuse detection for public endpoints",
    "Clone git@github.com:org/jarvis-core.git over SSH",
    "Clone ssh://git@gitlab.com/org/jarvis-core.git",
    "خطة هجرة قاعدة البيانات المحلية",
    "تنفيذ هجرة البيانات والمخطط بنجاح",
    "Refactor SQLite indexing batch loop",
  ];

  for (const example of technicalNonSensitiveExamples) {
    assert.equal(containsSensitiveContent(example), false, example);
  }

  const trueSensitiveDisclosures = [
    "sk-or-v1-abcdef0123456789",
    "My race and ethnicity are private",
    "She reported domestic abuse to the clinic",
    "Contact me at developer@github.com",
    "ما هي حالة الهجرة الخاصة بي؟",
    "أعاني من مشاكل هجرة وإقامة",
  ];

  for (const example of trueSensitiveDisclosures) {
    assert.equal(containsSensitiveContent(example), true, example);
  }
});
