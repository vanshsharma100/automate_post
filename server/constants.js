// Enums + platform contracts. Single source of truth shared by API and (via the
// bootstrap payload) the frontend, mirroring packages/shared in the plan.

export const UserRole = ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'];
export const UserStatus = ['ACTIVE', 'INVITED', 'SUSPENDED'];

export const ProviderKind = [
  'ANTHROPIC', 'OPENAI', 'GOOGLE', 'OPENAI_COMPATIBLE', 'AZURE_OPENAI',
  'STABILITY', 'REPLICATE', 'FAL', 'CUSTOM_HTTP',
];
export const Modality = ['TEXT', 'IMAGE', 'EMBEDDING', 'VISION', 'AUDIO', 'VIDEO'];
export const BrainRole = [
  'IDEATION', 'KEYWORD', 'DRAFT', 'HUMANIZE', 'SEO_AUDIT',
  'IMAGE_PROMPT', 'IMAGE_GEN', 'VISION_QA', 'POLICY', 'TRANSLATE', 'SUMMARIZE',
];

export const Platform = [
  'SHOPIFY_BLOG', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'GOOGLE_BUSINESS',
  'X_TWITTER', 'PINTEREST', 'THREADS', 'YOUTUBE', 'TIKTOK', 'WORDPRESS', 'CUSTOM_WEBHOOK',
];
export const ConnectionStatus = ['CONNECTED', 'DEGRADED', 'EXPIRED', 'DISCONNECTED', 'ERROR', 'PENDING_AUTH'];
export const OperationMode = ['MANUAL', 'AUTOPILOT', 'SHADOW', 'PAUSED'];

export const PostCategory = ['PRODUCT', 'KNOWLEDGE', 'PROMOTION', 'ANNOUNCEMENT', 'SEASONAL', 'CUSTOM'];
export const PostStatus = [
  'DRAFT', 'GENERATING', 'NEEDS_REVIEW', 'APPROVED', 'SCHEDULED',
  'PUBLISHING', 'PUBLISHED', 'FAILED', 'ARCHIVED',
];
export const MediaKind = ['IMAGE', 'VIDEO', 'GIF', 'DOCUMENT'];
export const MediaSource = ['UPLOAD', 'AI_GENERATED', 'SHOPIFY', 'STOCK', 'URL_IMPORT'];
export const KnowledgeScope = ['BRAIN_GLOBAL', 'PLATFORM', 'CONNECTION', 'BRAND_VOICE', 'PRODUCT_RULES'];
export const RunTrigger = ['CRON', 'MANUAL', 'API', 'WEBHOOK', 'RETRY'];
export const RunStatus = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'];
export const PurgeStrategy = ['OLDEST_FIRST', 'LARGEST_FIRST', 'PUBLISHED_ONLY', 'NEVER'];

// Platform display metadata + brand accents (doc 07).
export const PLATFORM_META = {
  SHOPIFY_BLOG: { label: 'Shopify Blog', short: 'Shopify', accent: '#95BF47', longForm: true },
  INSTAGRAM: { label: 'Instagram', short: 'Instagram', accent: '#E1306C', longForm: false },
  FACEBOOK: { label: 'Facebook', short: 'Facebook', accent: '#1877F2', longForm: false },
  LINKEDIN: { label: 'LinkedIn', short: 'LinkedIn', accent: '#0A66C2', longForm: false },
  GOOGLE_BUSINESS: { label: 'Google Business', short: 'GBP', accent: '#4285F4', longForm: false },
  CUSTOM_WEBHOOK: { label: 'Custom Webhook', short: 'Webhook', accent: '#9AA1B1', longForm: false },
  X_TWITTER: { label: 'X (Twitter)', short: 'X', accent: '#71767B', longForm: false },
  PINTEREST: { label: 'Pinterest', short: 'Pinterest', accent: '#E60023', longForm: false },
  THREADS: { label: 'Threads', short: 'Threads', accent: '#9AA1B1', longForm: false },
  YOUTUBE: { label: 'YouTube', short: 'YouTube', accent: '#FF0000', longForm: false },
  TIKTOK: { label: 'TikTok', short: 'TikTok', accent: '#9AA1B1', longForm: false },
  WORDPRESS: { label: 'WordPress', short: 'WordPress', accent: '#21759B', longForm: true },
};

// Connector capability contracts (doc 04 §1). Drives the composer's live
// character counters, hashtag warnings and media rules.
export const PLATFORM_CAPS = {
  SHOPIFY_BLOG: {
    text: { maxChars: 100000, markdown: true, links: 'inline' },
    media: { images: { min: 0, max: 10, aspects: ['16:9', '1.91:1'], maxBytes: 20e6 }, video: null },
    hashtags: { supported: false, recommended: 0, max: 0 },
    scheduling: 'native', editAfterPublish: true, deleteAfterPublish: true, requiresMedia: false,
    wordBand: [900, 1600],
  },
  LINKEDIN: {
    text: { maxChars: 3000, markdown: false, links: 'first-comment' },
    media: { images: { min: 0, max: 9, aspects: ['1.91:1', '1:1'], maxBytes: 8e6 }, video: { maxSeconds: 600, maxBytes: 200e6 } },
    hashtags: { supported: true, recommended: 4, max: 5 },
    scheduling: 'app-side', editAfterPublish: false, deleteAfterPublish: true, requiresMedia: false,
    wordBand: [180, 350],
  },
  INSTAGRAM: {
    text: { maxChars: 2200, markdown: false, links: 'none' },
    media: { images: { min: 1, max: 10, aspects: ['4:5', '1:1', '9:16'], maxBytes: 8e6 }, video: { maxSeconds: 90, maxBytes: 100e6 } },
    hashtags: { supported: true, recommended: 8, max: 30 },
    scheduling: 'app-side', editAfterPublish: false, deleteAfterPublish: true, requiresMedia: true,
    wordBand: [40, 150],
  },
  FACEBOOK: {
    text: { maxChars: 63206, markdown: false, links: 'inline' },
    media: { images: { min: 0, max: 10, aspects: ['1.91:1', '4:5'], maxBytes: 8e6 }, video: { maxSeconds: 240, maxBytes: 1e9 } },
    hashtags: { supported: true, recommended: 2, max: 6 },
    scheduling: 'native', editAfterPublish: true, deleteAfterPublish: true, requiresMedia: false,
    wordBand: [40, 200],
  },
  GOOGLE_BUSINESS: {
    text: { maxChars: 1500, markdown: false, links: 'inline' },
    media: { images: { min: 0, max: 1, aspects: ['4:3'], maxBytes: 5e6 }, video: null },
    hashtags: { supported: false, recommended: 0, max: 0 },
    scheduling: 'app-side', editAfterPublish: true, deleteAfterPublish: true, requiresMedia: false,
    wordBand: [40, 120],
    ctas: ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'],
  },
  CUSTOM_WEBHOOK: {
    text: { maxChars: 100000, markdown: true, links: 'inline' },
    media: { images: { min: 0, max: 10, aspects: ['*'], maxBytes: 50e6 }, video: { maxSeconds: 3600, maxBytes: 1e9 } },
    hashtags: { supported: true, recommended: 3, max: 30 },
    scheduling: 'app-side', editAfterPublish: false, deleteAfterPublish: false, requiresMedia: false,
    wordBand: [40, 400],
  },
};

// Image presets per platform (doc 03 §5).
export const IMAGE_PRESETS = {
  INSTAGRAM: { aspect: '4:5', w: 1080, h: 1350 },
  FACEBOOK: { aspect: '1.91:1', w: 1200, h: 630 },
  LINKEDIN: { aspect: '1.91:1', w: 1200, h: 627 },
  GOOGLE_BUSINESS: { aspect: '4:3', w: 1200, h: 900 },
  SHOPIFY_BLOG: { aspect: '16:9', w: 1920, h: 1080 },
  CUSTOM_WEBHOOK: { aspect: '1.91:1', w: 1200, h: 630 },
};

// The built-in AI-tell blocklist stripped by the humanizer (doc 05 §5).
export const AI_TELLS = [
  'delve', 'tapestry', 'testament to', "in today's fast-paced world", 'navigate the landscape',
  'unlock the potential', 'dive deep', 'game-changer', 'game changer', 'at the end of the day',
  'in conclusion', 'moreover', 'furthermore', 'it is important to note', 'needless to say',
  'when it comes to', 'in the realm of', 'a myriad of', 'seamless', 'elevate your',
  'in the ever-evolving', 'look no further', 'rest assured', "it's not just", 'embark on',
];

// Default recommended cadences (doc 05 §9).
export const DEFAULT_CADENCE = {
  SHOPIFY_BLOG: { perWeek: 2, slots: [{ dayOfWeek: 2, time: '09:30' }, { dayOfWeek: 4, time: '09:30' }] },
  LINKEDIN: { perWeek: 3, slots: [{ dayOfWeek: 1, time: '09:30' }, { dayOfWeek: 3, time: '09:30' }, { dayOfWeek: 5, time: '08:30' }] },
  FACEBOOK: { perWeek: 4, slots: [{ dayOfWeek: 1, time: '11:00' }, { dayOfWeek: 3, time: '11:00' }, { dayOfWeek: 5, time: '15:00' }, { dayOfWeek: 6, time: '10:00' }] },
  INSTAGRAM: { perWeek: 5, slots: [{ dayOfWeek: 1, time: '18:00' }, { dayOfWeek: 2, time: '18:00' }, { dayOfWeek: 3, time: '12:00' }, { dayOfWeek: 4, time: '18:00' }, { dayOfWeek: 5, time: '19:00' }] },
  GOOGLE_BUSINESS: { perWeek: 1, slots: [{ dayOfWeek: 2, time: '10:00' }] },
  CUSTOM_WEBHOOK: { perWeek: 3, slots: [{ dayOfWeek: 1, time: '10:00' }, { dayOfWeek: 3, time: '10:00' }, { dayOfWeek: 5, time: '10:00' }] },
};

export const ERROR = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INTERNAL: 'INTERNAL',
};
