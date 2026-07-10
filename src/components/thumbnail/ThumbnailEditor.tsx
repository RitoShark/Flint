import '../../styles/design-lab.css';

export function ThumbnailEditor({ project, skn }: { project: string; skn: string }) {
  return (
    <div className="dl-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>Thumbnail Creator</strong>
        <span className="dl-badge">{skn.split(/[\\/]/).pop()}</span>
      </div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
        Editor mounts here — project: {project || '(none)'}
      </div>
    </div>
  );
}
