const SENSITIVE_PATTERNS = [
  /\b(?:sk-or-v1-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{16,})\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{80,255}\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b(?:my\s+)?(?:password|passphrase|api[ _-]?key|secret|access token|refresh token)\s*(?:is|[:=])\s*\S+/i,
  /\b(?:diagnosis|disease|medication|prescription|symptom|therapy|pregnan(?:t|cy)|diabetes|asthma|cancer|depression|hiv)\b|\b(?:i|we)\s+(?:am|are|was|were|have been)\s+diagnosed\b/i,
  /\b(?:bank account|credit card|debit card|social security|passport number|national id|home address|precise location|religion|political views|sexual orientation|ethnicity|(?<!\b(?:data|lock|thread|concurrency|memory|write|read|async|ipc|process|file|signal|pointer|eviction|unlink)\s)race(?!\s+(?:condition|conditions|detector|detectors|hazard|hazards|window|windows|bug|bugs|test|tests|issue|issues|between|in|on|during)\b)|criminal record|immigration status|disability|addiction|(?<!\b(?:api|rate[- ]limit|limit|quota|resource|system|service|endpoint|bot|spam|token|privilege|memory|cpu|network|protocol|feature)\s)abuse(?!\s+(?:detection|prevention|protection|mitigation|filter|filters|rate|limit|limits)\b)|trauma|biometric)\b/i,
  /(?<!(?:ssh|git):\/\/)(?<![A-Z0-9._%+-])(?!git@[A-Z0-9.-]+\.[A-Z]{2,}:[A-Z0-9._/-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b(?!:[A-Z0-9._/-]+\.git\b)/i,
  /\+\d[\d\s().-]{7,}\d/,
  /\b(?:mijn\s+)?(?:wachtwoord|paswoord|wachtzin|api[- ]?sleutel|geheime sleutel|toegangstoken|vernieuwingstoken)\s*(?:is|[:=])\s*\S+/i,
  /\b(?:diagnose|ziekte|aandoening|diabetes|astma|kanker|depressie|medicijn(?:en)?|medicatie|recept|symptoom|therapie|zwangerschap|zwanger|hiv)\b/i,
  /\b(?:bankrekening|creditcard|bankpas|burgerservicenummer|bsn|paspoortnummer|identiteitsbewijs|woonadres|huisadres|exacte locatie|religie|geloof|politieke voorkeur|seksuele geaardheid|etniciteit|ras|strafblad|immigratiestatus|handicap|verslaving|misbruik|trauma|biometrische gegevens)\b/i,
  /(?<![\p{L}\p{N}])(?:كلمة المرور|كلمة سر|كلمة السر|مفتاح api|مفتاح سري|رمز سري|رمز الدخول)(?![\p{L}\p{N}])\s*[:=،,؛.!-]?\s*\S+/iu,
  /(?<![\p{L}\p{N}])(?:انا حامل|اعاني من (?:مشاكل|مشكلة|صعوبات) في الحمل|اختبار الحمل ايجابي|دواء|ادوية|مرض|تشخيص|اعراض|علاج نفسي|سكري|السكري|داء السكري|ربو|سرطان|اكتئاب|حساب بنكي|بطاقة ائتمان|رقم الهوية|رقم جواز|عنوان المنزل|موقع دقيق|ديانة|معتقد ديني|راي سياسي|ميول جنسية|عرق|اصل عرقي|سجل جنائي|(?:ال)?هجرة(?!\s+(?:قاعدة\s+البيانات|قواعد\s+البيانات|البيانات|المخطط|النظام|الانظمة|الكود|البرمجيات|الخدمة|الخدمات|الخادم|الخوادم|الجداول|الجدول|الملفات|الاصدار|الاصدارات|التطبيق|التطبيقات|المشروع|المستودع))|اعاقة|ادمان|اساءة|صدمة نفسية|بيانات حيوية)(?![\p{L}\p{N}])/u,
];

const LOCAL_PHONE_DISCLOSURE =
  /(?:(?:\b(?:my\s+)?(?:phone|telephone|mobile|cell(?:ular)?(?:\s+phone)?)(?:\s+number)?\b|\b(?:mijn\s+)?(?:telefoonnummer|mobiel(?:e)?(?:\s+nummer)?|gsm-nummer)\b)|(?<![\p{L}\p{N}])(?:رقم\s+(?:هاتفي|الهاتف|الجوال|تلفوني)|(?:هاتفي|جوالي|تلفوني)\s+رقم)(?![\p{L}\p{N}]))\s*(?:(?:is|[:=،,؛])\s*)?(\(?\d[\d ().-]{5,}\d\)?)/giu;

export function containsSensitiveContent(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/\u0640/gu, "")
    .replace(/[٠-٩۰-۹]/gu, (digit) =>
      String(digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)),
    )
    .replace(/\s+/gu, " ")
    .trim();

  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  LOCAL_PHONE_DISCLOSURE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_PHONE_DISCLOSURE.exec(normalized)) !== null) {
    const digitCount = match[1].replace(/\D/gu, "").length;
    if (digitCount >= 7 && digitCount <= 15) return true;
  }
  return false;
}
