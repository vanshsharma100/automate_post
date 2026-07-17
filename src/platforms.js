'use strict';

/**
 * Single source of truth for every posting destination.
 *
 * Adding or removing a platform should only require editing THIS list — the
 * server, store, scheduler, content brain and views all read from here instead
 * of hard-coding ['gmb','linkedin','ig','fb'] in a dozen places.
 *
 * Fields:
 *   key      internal id, also used in form field names (e.g. `<key>_days`)
 *   label    human name shown in the UI
 *   icon     emoji used in tabs / headings
 *   kind     'social' = short social post · 'blog' = long-form article
 *   maxChars soft length budget passed to the writer
 *   style    tone/format hint for the writer
 *   fields   the ID field(s) an account on this platform needs to publish
 *   app      which developer-app credential this platform publishes through
 *            ('meta' | 'linkedin' | 'google' | 'shopify')
 *   needsAccountToken  false = publishes with the store/app connection, so a
 *            per-account access token is not required (used by Shopify Blog)
 */
const PLATFORMS = [
  {
    key: 'gmb',
    label: 'Google Business',
    icon: '📍',
    kind: 'social',
    maxChars: 1500,
    style: 'Local, helpful, with a clear call to action. No hashtags.',
    fields: [
      { name: 'accountId', label: 'GBP Account ID' },
      { name: 'locationId', label: 'GBP Location ID' },
    ],
    app: 'google',
    needsAccountToken: true,
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    icon: '💼',
    kind: 'social',
    maxChars: 1200,
    style: 'Professional and concise. Minimal emojis. One or two tasteful hashtags.',
    fields: [{ name: 'orgUrn', label: 'LinkedIn Organization URN / Page ID' }],
    app: 'linkedin',
    needsAccountToken: true,
  },
  {
    key: 'ig',
    label: 'Instagram',
    icon: '📸',
    kind: 'social',
    maxChars: 900,
    style: 'Short, punchy, friendly. Emojis and 4-6 relevant hashtags. "Link in bio".',
    fields: [{ name: 'igId', label: 'Instagram Business ID' }],
    app: 'meta',
    needsAccountToken: true,
  },
  {
    key: 'fb',
    label: 'Facebook',
    icon: '📘',
    kind: 'social',
    maxChars: 900,
    style: 'Warm and conversational. A few emojis. 2-3 hashtags. Include the website.',
    fields: [{ name: 'pageId', label: 'Facebook Page ID' }],
    app: 'meta',
    needsAccountToken: true,
  },
  {
    key: 'blog',
    label: 'Shopify Blog',
    icon: '📝',
    kind: 'blog',
    maxChars: 6000,
    style:
      'Long-form SEO blog article. Start with a strong title line, a short intro, ' +
      'a few clear subheadings, genuinely helpful detail, and a closing call to action. No hashtags.',
    fields: [{ name: 'blogId', label: 'Shopify Blog ID (which blog to publish to)' }],
    app: 'shopify',
    needsAccountToken: false, // publishes through the Shopify store connection
  },
];

const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);
const PLATFORM_MAP = PLATFORMS.reduce((m, p) => {
  m[p.key] = p;
  return m;
}, {});

module.exports = { PLATFORMS, PLATFORM_KEYS, PLATFORM_MAP };
