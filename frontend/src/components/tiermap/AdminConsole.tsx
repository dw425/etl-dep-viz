/**
 * AdminConsole — manage projects, uploads, and data cleanup.
 * Lists all projects and uploads with delete/clear capabilities.
 * Deleting a project or upload CASCADE-deletes all materialized table data.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  listProjects,
  getProject,
  deleteProject,
  deleteUpload,
  listUploads,
  type ProjectSummary,
  type UploadSummary,
} from '../../api/client';

interface ProjectDetail extends ProjectSummary {
  uploads: Array<{ id: number; filename: string; platform: string; session_count: number; created_at: string | null }>;
}

interface AdminConsoleProps {
  onToast?: (message: string, severity: 'error' | 'warning' | 'info' | 'success') => void;
  onLoadUpload?: (uploadId: number) => void;
}

/**
 * AdminConsole -- project and upload management dashboard.
 *
 * Displays all projects with their uploads, plus orphan uploads not belonging
 * to any project. Supports cascade delete (project -> uploads -> analysis data)
 * and a "Clear All Data" nuclear option. Stats bar shows aggregate counts.
 */
export default function AdminConsole({ onToast, onLoadUpload }: AdminConsoleProps) {
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [orphanUploads, setOrphanUploads] = useState<UploadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'project' | 'upload' | 'all'; id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch projects and uploads independently so one failing doesn't block the other
      let projs: ProjectSummary[] = [];
      let allUploads: UploadSummary[] = [];
      try { projs = await listProjects(); } catch { /* no projects table yet */ }
      try { allUploads = await listUploads(500); } catch { /* ok */ }

      // Load details for each project (includes uploads list)
      const details: ProjectDetail[] = await Promise.all(
        projs.map(async (p) => {
          try {
            const detail = await getProject(p.id);
            return { ...p, uploads: detail.uploads || [] };
          } catch {
            return { ...p, uploads: [] };
          }
        })
      );

      // Find orphan uploads (not associated with any project) using project_id field
      const orphans = allUploads.filter(u => !u.project_id);

      setProjects(details);
      setOrphanUploads(orphans);
    } catch (err) {
      onToast?.(`Failed to load data: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      if (confirmDelete.type === 'project') {
        await deleteProject(confirmDelete.id);
        onToast?.(`Deleted project "${confirmDelete.name}" and all its uploads`, 'success');
      } else if (confirmDelete.type === 'upload') {
        await deleteUpload(confirmDelete.id);
        onToast?.(`Deleted upload "${confirmDelete.name}" and all related data`, 'success');
      }
      setConfirmDelete(null);
      await loadData();
    } catch (err) {
      onToast?.(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete, loadData, onToast]);

  const handleClearAll = useCallback(async () => {
    setDeleting(true);
    try {
      // Delete all projects (cascades to their uploads)
      for (const p of projects) {
        await deleteProject(p.id);
      }
      // Delete orphan uploads
      for (const u of orphanUploads) {
        await deleteUpload(u.id);
      }
      onToast?.('All data cleared successfully', 'success');
      setConfirmDelete(null);
      await loadData();
    } catch (err) {
      onToast?.(`Clear all failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setDeleting(false);
    }
  }, [projects, orphanUploads, loadData, onToast]);

  const totalUploads = projects.reduce((sum, p) => sum + p.uploads.length, 0) + orphanUploads.length;
  const totalSessions = [
    ...projects.flatMap(p => p.uploads),
    ...orphanUploads,
  ].reduce((sum, u) => sum + (u.session_count || 0), 0);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#1a2332' }}>
      {/* Header */}
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>Admin Console</h1>
            <p style={{ fontSize: 12, color: '#8899aa', marginTop: 4 }}>
              Manage projects, uploads, and data. Deleting removes all associated analysis data.
            </p>
          </div>
          <button
            onClick={() => setConfirmDelete({ type: 'all', id: 0, name: 'ALL DATA' })}
            disabled={totalUploads === 0}
            style={{
              padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: totalUploads > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(100,116,139,0.1)',
              color: totalUploads > 0 ? '#EF4444' : '#5a6a7a',
              border: `1px solid ${totalUploads > 0 ? 'rgba(239,68,68,0.3)' : 'rgba(100,116,139,0.2)'}`,
              cursor: totalUploads > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            Clear All Data
          </button>
        </div>

        {/* Stats bar */}
        <div style={{
          display: 'flex', gap: 24, padding: '12px 16px', borderRadius: 8,
          background: '#243044', border: '1px solid #3a4a5e', marginBottom: 24,
        }}>
          <Stat label="Projects" value={projects.length} color="#3B82F6" />
          <Stat label="Uploads" value={totalUploads} color="#10B981" />
          <Stat label="Sessions" value={totalSessions} color="#A855F7" />
          <Stat label="Orphan Uploads" value={orphanUploads.length} color={orphanUploads.length > 0 ? '#F59E0B' : '#5a6a7a'} />
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: '#8899aa' }}>Loading...</div>
        )}

        {/* Projects */}
        {!loading && projects.map(project => (
          <div key={project.id} style={{
            marginBottom: 16, borderRadius: 8, border: '1px solid #3a4a5e',
            background: '#243044', overflow: 'hidden',
          }}>
            {/* Project header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderBottom: '1px solid #3a4a5e',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3B82F6' }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{project.name}</span>
                <span style={{ fontSize: 11, color: '#8899aa' }}>
                  {project.uploads.length} upload{project.uploads.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setConfirmDelete({ type: 'project', id: project.id, name: project.name })}
                  style={{
                    padding: '4px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                    background: 'rgba(239,68,68,0.1)', color: '#EF4444',
                    border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer',
                  }}
                >
                  Delete Project
                </button>
              </div>
            </div>

            {/* Project uploads */}
            {project.uploads.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: 11, color: '#5a6a7a' }}>No uploads</div>
            ) : (
              project.uploads.map(upload => (
                <UploadRow
                  key={upload.id}
                  upload={upload}
                  onLoad={() => onLoadUpload?.(upload.id)}
                  onDelete={() => setConfirmDelete({ type: 'upload', id: upload.id, name: upload.filename })}
                />
              ))
            )}
          </div>
        ))}

        {/* Orphan uploads */}
        {!loading && orphanUploads.length > 0 && (
          <div style={{
            marginBottom: 16, borderRadius: 8, border: '1px solid rgba(245,158,11,0.3)',
            background: '#243044', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 16px', borderBottom: '1px solid #3a4a5e',
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#F59E0B' }}>Unassigned Uploads</span>
              <span style={{ fontSize: 11, color: '#8899aa' }}>
                {orphanUploads.length} upload{orphanUploads.length !== 1 ? 's' : ''} not in any project
              </span>
            </div>
            {orphanUploads.map(upload => (
              <UploadRow
                key={upload.id}
                upload={upload}
                onLoad={() => onLoadUpload?.(upload.id)}
                onDelete={() => setConfirmDelete({ type: 'upload', id: upload.id, name: upload.filename })}
              />
            ))}
          </div>
        )}

        {!loading && projects.length === 0 && orphanUploads.length === 0 && (
          <div style={{
            textAlign: 'center', padding: 48, color: '#5a6a7a', fontSize: 13,
            border: '1px dashed #3a4a5e', borderRadius: 8,
          }}>
            No projects or uploads. Upload an XML file from the dashboard to get started.
          </div>
        )}
      </div>

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{
            background: '#3a4a5e', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%',
            border: '1px solid rgba(239,68,68,0.3)',
          }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', margin: '0 0 8px' }}>
              Confirm Delete
            </h3>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 16px', lineHeight: 1.5 }}>
              {confirmDelete.type === 'all'
                ? `This will permanently delete ALL ${projects.length} projects and ${totalUploads} uploads, including all analysis data, materialized tables, and vector results. This cannot be undone.`
                : confirmDelete.type === 'project'
                ? `Delete project "${confirmDelete.name}" and all its uploads? This will remove all analysis data, materialized tables, and vector results for every upload in this project.`
                : `Delete upload "${confirmDelete.name}"? This will remove all associated analysis data, materialized tables, and vector results.`
              }
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                style={{
                  padding: '8px 16px', borderRadius: 6, fontSize: 12,
                  background: 'transparent', color: '#94a3b8',
                  border: '1px solid #374151', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete.type === 'all' ? handleClearAll : handleDelete}
                disabled={deleting}
                style={{
                  padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                  background: '#EF4444', color: '#fff',
                  border: 'none', cursor: deleting ? 'wait' : 'pointer',
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                {deleting ? 'Deleting...' : confirmDelete.type === 'all' ? 'Delete Everything' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Colored stat badge for the summary bar. */
function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value.toLocaleString()}</div>
      <div style={{ fontSize: 10, color: '#8899aa', marginTop: 2 }}>{label}</div>
    </div>
  );
}

/** Single upload row with filename, metadata, and Load/Delete action buttons. */
function UploadRow({ upload, onLoad, onDelete }: {
  upload: { id: number; filename: string; platform?: string; session_count: number; created_at: string | null };
  onLoad: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 16px', borderBottom: '1px solid rgba(30,41,59,0.5)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {upload.filename}
        </div>
        <div style={{ fontSize: 10, color: '#8899aa', marginTop: 2, display: 'flex', gap: 8 }}>
          {upload.platform && <span>{upload.platform}</span>}
          <span>{upload.session_count.toLocaleString()} sessions</span>
          {upload.created_at && <span>{new Date(upload.created_at).toLocaleDateString()}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onLoad}
          style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 10,
            background: 'rgba(59,130,246,0.1)', color: '#3B82F6',
            border: '1px solid rgba(59,130,246,0.2)', cursor: 'pointer',
          }}
        >
          Load
        </button>
        <button
          onClick={onDelete}
          style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 10,
            background: 'rgba(239,68,68,0.1)', color: '#EF4444',
            border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer',
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
