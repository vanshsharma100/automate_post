import React from 'react';
import { Ring, Icon, Badge, cx } from '../ui.jsx';

// The SEO panel — score ring + the 17 checks as a live checklist (doc 07 §6).
export function SeoPanel({ seo, human }) {
  if (!seo) return null;
  const checks = (seo.checks || []).filter((c) => c.applicable);
  const failed = checks.filter((c) => !c.pass);
  return (
    <div>
      <div className="row gap-16" style={{ alignItems: 'center', marginBottom: 6 }}>
        <Ring value={seo.score} size={62} stroke={6} />
        <div>
          <div className="row gap-8"><b>SEO score</b><Badge variant={seo.score >= 75 ? 'success' : seo.score >= 50 ? 'warning' : 'danger'}>{seo.passedCount}/{seo.applicableCount} checks</Badge></div>
          <div className="tiny dim mt-8">{seo.wordCount} words · Flesch {seo.readability}{human ? ` · style ${human.score}` : ''}</div>
        </div>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 10 }}>
        {[...failed, ...checks.filter((c) => c.pass)].map((c) => (
          <div key={c.id} className="check-row">
            <span className={cx('check-ic', c.pass ? 'pass' : 'fail')}>{c.pass ? '✓' : '!'}</span>
            <div className="grow">
              <div className="small" style={{ fontWeight: 500 }}>{c.label} {c.detail && <span className="dim mono tiny">· {c.detail}</span>}</div>
              {!c.pass && <div className="tiny dim">{c.fix}</div>}
            </div>
            <span className="tiny dim mono">w{c.weight}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
