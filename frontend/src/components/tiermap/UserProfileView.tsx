/**
 * UserProfileView — User profile, upload history, activity log.
 * No login required — uses localStorage UUID.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getUserId,
  getUser,
  upsertUser,
  getUserUploads,
  getUserActivity,
  deleteUpload,
  logActivity,
  type UploadSummary,
} from '../../api/client';

interface Props {
  onLoadUpload: (id: number) => void;
}

/**
 * UserProfileView -- user profile page showing display name (editable),
 * quick stats (uploads, sessions parsed, member since), upload history
 * table with load/delete actions, and activity log with timestamped entries.
 * Uses localStorage UUID for anonymous identification (no login required).
 */
export default function UserProfileView({ onLoadUpload }: Props) {
  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [displayName, setDisplayName] = useState('');
  const [editing, setEditing] = useState(false);
  const [uploads, setUploads] = useState<UploadSummary[]>([]);
  const [activity, setActivity] = useState<Record<string, unknown>[]>([]);
  const [tab, setTab] = useState<'uploads' | 'activity'>('uploads');

  const userId = getUserId();

  const loadData = useCallback(async () => {
    try {
      const [u, up, act] = await Promise.all([
        getUser(),
        getUserUploads(),
        getUserActivity(),
      ]);
      setProfile(u);
      setDisplayName((u.display_name as string) || '');
      setUploads(up);
      setActivity(act);
    } catch {
      // Graceful fallback — profile view still renders with empty data
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSaveName = async () => {
    await upsertUser(displayName);
    setEditing(false);
    loadData();
  };

  const handleDelete = async (id: number, filename: string) => {
    await deleteUpload(id);
    logActivity('delete', filename, { upload_id: id });
    loadData();
  };

  const formatDuration = (ms: number | null) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      {/* Profile header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>User Profile</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%', background: '#3b82f6',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 20, fontWeight: 700,
          }}>
            {(displayName || 'U')[0].toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            {editing ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Display name"
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid #8899aa', background: 'transparent', color: 'inherit', fontSize: 13 }}
                  onKeyDown={e => e.key === 'Enter' && handleSaveName()}
                  autoFocus
                />
                <button onClick={handleSaveName} style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: '#3b82f6', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Save</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{displayName || 'Anonymous User'}</span>
                <button onClick={() => setEditing(true)} style={{ fontSize: 10, color: '#8899aa', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>edit</button>
              </div>
            )}
            <div style={{ fontSize: 11, color: '#8899aa', marginTop: 2 }}>ID: {userId.slice(0, 8)}...</div>
          </div>
        </div>

        {/* Quick stats */}
        <div style={{ display: 'flex', gap: 24 }}>
          {[
            { label: 'Uploads', value: profile.upload_count ?? 0 },
            { label: 'Sessions Parsed', value: profile.total_sessions ?? 0 },
            { label: 'Member Since', value: profile.created_at ? new Date(profile.created_at as string).toLocaleDateString() : '-' },
          ].map(s => (
            <div key={s.label}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{String(s.value)}</div>
              <div style={{ fontSize: 10, color: '#8899aa' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #4a5a6e' }}>
        {(['uploads', 'activity'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '6px 16px', border: 'none', borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
              background: 'transparent', color: tab === t ? '#3b82f6' : '#8899aa',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
            }}
          >{t}</button>
        ))}
      </div>

      {/* Upload history */}
      {tab === 'uploads' && (
        <div>
          {uploads.length === 0 && <div style={{ color: '#8899aa', fontSize: 13, textAlign: 'center', padding: 32 }}>No uploads yet</div>}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            {uploads.length > 0 && (
              <thead>
                <tr style={{ borderBottom: '1px solid #4a5a6e' }}>
                  <th style={{ textAlign: 'left', padding: '8px 4px', color: '#8899aa', fontWeight: 600 }}>Filename</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#8899aa', fontWeight: 600 }}>Sessions</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#8899aa', fontWeight: 600 }}>Parse Time</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#8899aa', fontWeight: 600 }}>Date</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#8899aa', fontWeight: 600 }}>Actions</th>
                </tr>
              </thead>
            )}
            <tbody>
              {uploads.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid #3a4a5e' }}>
                  <td style={{ padding: '8px 4px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.filename}</td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>{u.session_count}</td>
                  <td style={{ padding: '8px 4px', textAlign: 'right', color: '#8899aa' }}>{formatDuration(u.parse_duration_ms)}</td>
                  <td style={{ padding: '8px 4px', textAlign: 'right', color: '#8899aa' }}>{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                    <button onClick={() => onLoadUpload(u.id)} style={{ fontSize: 11, color: '#3b82f6', background: 'transparent', border: 'none', cursor: 'pointer', marginRight: 8 }}>Load</button>
                    <button onClick={() => handleDelete(u.id, u.filename)} style={{ fontSize: 11, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer' }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Activity log */}
      {tab === 'activity' && (
        <div>
          {activity.length === 0 && <div style={{ color: '#8899aa', fontSize: 13, textAlign: 'center', padding: 32 }}>No activity yet</div>}
          {activity.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #3a4a5e', fontSize: 12 }}>
              <span style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                background: (a.action as string) === 'upload' ? 'rgba(16,185,129,0.2)' : (a.action as string) === 'delete' ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)',
                color: (a.action as string) === 'upload' ? '#10B981' : (a.action as string) === 'delete' ? '#ef4444' : '#3b82f6',
              }}>{a.action as string}</span>
              <span style={{ flex: 1, color: '#e2e8f0' }}>{(a.target_filename as string) || '-'}</span>
              <span style={{ color: '#8899aa', fontSize: 10 }}>{a.created_at ? new Date(a.created_at as string).toLocaleString() : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
