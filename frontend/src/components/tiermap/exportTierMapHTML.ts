/**
 * exportTierMapHTML.ts — Generates a self-contained interactive HTML document
 * matching the Lumen_Retro reference format: React 18 + Babel from CDN,
 * 6 views (Tier Diagram, Constellation, Explorer, Conflicts, Exec Order, Matrix),
 * all with hover/click/selection interactivity.
 *
 * Data from TierMapResult + optional ConstellationResult replaces hardcoded values.
 */

import type { TierMapResult, ConstellationResult } from '../../types/tiermap';
import type { VectorResults } from '../../types/vectors';

// ── Derive session-level detail from connections ─────────────────────────────

interface SessionDetail {
  short: string;
  step: number;
  tier: number;
  transforms: number;
  extReads: number;
  lookupCount: number;
  critical: boolean;
  sources: string[];
  targets: string[];
  lookups: string[];
  transformDetail: Record<string, number>;
}

function buildSessionData(data: TierMapResult): Record<string, SessionDetail> {
  const tableIdToName = new Map<string, string>();
  data.tables.forEach(t => tableIdToName.set(t.id, t.name));

  const result: Record<string, SessionDetail> = {};
  data.sessions.forEach(s => {
    const targets: string[] = [];
    const sources: string[] = [];
    const lookups: string[] = [];

    data.connections.forEach(c => {
      if (c.from === s.id && tableIdToName.has(c.to)) {
        const tName = tableIdToName.get(c.to)!;
        if (!targets.includes(tName)) targets.push(tName);
      }
      if (c.to === s.id && tableIdToName.has(c.from)) {
        const tName = tableIdToName.get(c.from)!;
        if (c.type === 'read_after_write' || c.type === 'source_read') {
          if (!sources.includes(tName)) sources.push(tName);
        } else if (c.type === 'lookup_stale') {
          if (!lookups.includes(tName)) lookups.push(tName);
        }
      }
    });

    result[s.full] = {
      short: s.name,
      step: s.step,
      tier: s.tier,
      transforms: s.transforms,
      extReads: s.extReads,
      lookupCount: s.lookupCount,
      critical: s.critical,
      sources,
      targets,
      lookups,
      transformDetail: {},
    };
  });
  return result;
}

// ── Main export ──────────────────────────────────────────────────────────────

export function buildTierMapHTML(data: TierMapResult, constellation?: ConstellationResult, vectorResults?: VectorResults | null, selectedViews?: Set<string>): string {
  const sessionData = buildSessionData(data);
  const execOrder = data.sessions.slice().sort((a, b) => a.step - b.step).map(s => s.full);

  const sessionDataJSON = JSON.stringify(sessionData, null, 2);
  const execOrderJSON = JSON.stringify(execOrder);
  const tierSessionsJSON = JSON.stringify(data.sessions);
  const tierTablesJSON = JSON.stringify(data.tables);
  const tierConnectionsJSON = JSON.stringify(data.connections);
  const statsJSON = JSON.stringify(data.stats);
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const includeView = (id: string) => !selectedViews || selectedViews.has(id);

  const includeConstellation = includeView('constellation') && constellation && constellation.points.length > 0;
  const constellationPointsJSON = includeConstellation ? JSON.stringify(constellation.points) : '[]';
  const constellationChunksJSON = includeConstellation ? JSON.stringify(constellation.chunks) : '[]';
  const crossChunkEdgesJSON = includeConstellation ? JSON.stringify(constellation.cross_chunk_edges) : '[]';
  const hasConstellation = !!includeConstellation;

  // Extract only the vector data needed by selected export views
  const needVectors = includeView('complexity') || includeView('waves') || includeView('heatmap')
    || includeView('concentration') || includeView('consensus');
  const vectorSubset = vectorResults && needVectors ? {
    v1_communities: vectorResults.v1_communities ?? null,
    v4_wave_plan: vectorResults.v4_wave_plan ?? null,
    v8_ensemble_consensus: vectorResults.v8_ensemble_consensus ?? null,
    v9_wave_function: vectorResults.v9_wave_function ?? null,
    v10_concentration: vectorResults.v10_concentration ?? null,
    v11_complexity: vectorResults.v11_complexity ?? null,
  } : null;
  const vectorResultsJSON = JSON.stringify(vectorSubset);
  const connectionProfilesJSON = JSON.stringify(
    (data as unknown as Record<string, unknown>).connection_profiles ?? []
  );

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Lakehouse Optimizer — Session Dependency Diagram</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;background:#1a2332}#root{width:100vw;height:100vh}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#4a5a6e;border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#5a6a7a}</style>
</head><body><div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js"><\/script>
<script type="text/babel">
const{useState,useCallback,useMemo,useRef,useEffect}=React;

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER — injected from TierMapResult + ConstellationResult
// ═══════════════════════════════════════════════════════════════════════════════

const sessionData = ${sessionDataJSON};
const executionOrder = ${execOrderJSON};
const tierSessions = ${tierSessionsJSON};
const tierTables = ${tierTablesJSON};
const tierConnections = ${tierConnectionsJSON};
const tierStats = ${statsJSON};
const exportTimestamp = "${timestamp}";
const constellationPoints = ${constellationPointsJSON};
const constellationChunks = ${constellationChunksJSON};
const crossChunkEdges = ${crossChunkEdgesJSON};
const hasConstellation = ${hasConstellation ? 'true' : 'false'};
const vectorResults = ${vectorResultsJSON};
const connectionProfiles = ${connectionProfilesJSON};
const hasVectors = vectorResults !== null;
const hasComplexity = !!(vectorResults?.v11_complexity);
const hasWavePlan = !!(vectorResults?.v4_wave_plan);
const hasConcentration = !!(vectorResults?.v10_concentration);
const hasEnsemble = !!(vectorResults?.v8_ensemble_consensus);
const includeViews = ${selectedViews ? `new Set(${JSON.stringify([...selectedViews])})` : 'null'};
const iv = (id) => !includeViews || includeViews.has(id);

// Derive write conflicts, read-after-write chains, and table maps
const writeConflicts = {}; const readAfterWrite = {}; const allTargets = {}; const allSources = {}; const allTables = {};
Object.entries(sessionData).forEach(([n,s])=>{
  s.targets.forEach(t=>{if(!allTargets[t])allTargets[t]=[];allTargets[t].push(n);});
  [...s.sources,...s.lookups].forEach(t=>{if(!allSources[t])allSources[t]=[];if(!allSources[t].includes(n))allSources[t].push(n);});
  s.targets.forEach(t=>{if(!allTables[t])allTables[t]={writes:[],reads:[],lookups:[]};allTables[t].writes.push(n);});
  s.sources.forEach(t=>{if(!allTables[t])allTables[t]={writes:[],reads:[],lookups:[]};allTables[t].reads.push(n);});
  s.lookups.forEach(t=>{if(!allTables[t])allTables[t]={writes:[],reads:[],lookups:[]};if(!allTables[t].lookups.includes(n))allTables[t].lookups.push(n);});
});
Object.entries(allTargets).forEach(([t,w])=>{if(w.length>1)writeConflicts[t]=w;});
Object.entries(allTargets).forEach(([t,w])=>{const r=allSources[t]?.filter(x=>!w.includes(x))||[];if(r.length>0)readAfterWrite[t]={writers:w,readers:r};});

const C = {bg:"#1a2332",surface:"#243044",border:"#3a4a5e",borderActive:"#3b82f6",text:"#e2e8f0",textMuted:"#8899aa",textDim:"#5a6a7a",write:"#ef4444",read:"#22c55e",lookup:"#f59e0b",conflict:"#ef4444",chain:"#a855f7",accentBlue:"#60a5fa"};

const connTypes = {
  write_conflict:{color:"#EF4444",label:"Write Conflict",dash:"",baseWidth:3},
  write_clean:{color:"#3B82F6",label:"Clean Write",dash:"",baseWidth:1.5},
  read_after_write:{color:"#A855F7",label:"Read-After-Write",dash:"",baseWidth:2},
  lookup_stale:{color:"#F59E0B",label:"Lookup Staleness",dash:"6,3",baseWidth:2},
  chain:{color:"#F97316",label:"Dependency Chain",dash:"",baseWidth:2.5},
  source_read:{color:"#10B981",label:"Source Read",dash:"",baseWidth:1.5},
};

// Dynamic tier config (supports any tier depth)
const TIER_CFG_STATIC = {
  0.5:{label:"EXTERNAL SOURCES & REFERENCE TABLES",color:"#10B981",bgAlpha:"rgba(16,185,129,0.06)",border:"#059669"},
  1:{label:"TIER 1 — INDEPENDENT PARALLEL EXECUTION",color:"#3B82F6",bgAlpha:"rgba(59,130,246,0.06)",border:"#2563EB"},
  1.5:{label:"TIER 1 OUTPUTS",color:"#22C55E",bgAlpha:"rgba(34,197,94,0.05)",border:"#16A34A"},
  2:{label:"TIER 2 — DEPENDENT ON TIER 1",color:"#EAB308",bgAlpha:"rgba(234,179,8,0.06)",border:"#CA8A04"},
  2.5:{label:"⚠ CRITICAL GATE — WRITE CONFLICTS",color:"#EF4444",bgAlpha:"rgba(239,68,68,0.08)",border:"#DC2626"},
  3:{label:"TIER 3 — DOWNSTREAM CONSUMERS",color:"#A855F7",bgAlpha:"rgba(168,85,247,0.06)",border:"#9333EA"},
  3.5:{label:"TIER 3 OUTPUTS & CHAIN TABLES",color:"#F97316",bgAlpha:"rgba(249,115,22,0.05)",border:"#EA580C"},
  4:{label:"TIER 4 — DEEP DOWNSTREAM",color:"#06B6D4",bgAlpha:"rgba(6,182,212,0.06)",border:"#0891B2"},
  4.5:{label:"TIER 4 OUTPUTS",color:"#8B5CF6",bgAlpha:"rgba(139,92,246,0.05)",border:"#7C3AED"},
  5:{label:"TIER 5 — DEEP PIPELINE",color:"#EC4899",bgAlpha:"rgba(236,72,153,0.06)",border:"#DB2777"},
  5.5:{label:"TIER 5 OUTPUTS",color:"#84CC16",bgAlpha:"rgba(132,204,22,0.05)",border:"#65A30D"},
  6:{label:"TIER 6 — ADVANCED DOWNSTREAM",color:"#F43F5E",bgAlpha:"rgba(244,63,94,0.06)",border:"#E11D48"},
  6.5:{label:"TIER 6 OUTPUTS",color:"#14B8A6",bgAlpha:"rgba(20,184,166,0.05)",border:"#0D9488"},
};
const PALETTE=["#3B82F6","#EAB308","#A855F7","#10B981","#F97316","#06B6D4","#EC4899","#84CC16","#F43F5E","#8B5CF6","#14B8A6","#FB923C","#818CF8","#34D399","#F87171"];
function getTierCfg(tier){
  if(TIER_CFG_STATIC[tier])return TIER_CFG_STATIC[tier];
  const isHalf=tier%1!==0;const base=Math.floor(tier);
  const color=PALETTE[(base-1)%PALETTE.length];
  return{label:isHalf?"TIER "+base+" OUTPUTS":"TIER "+base+" — PIPELINE STAGE",color,bgAlpha:color+"0F",border:color};
}

// Build tier groups dynamically
const allTierNums = new Set();
tierSessions.forEach(s=>allTierNums.add(s.tier));
tierTables.forEach(t=>allTierNums.add(t.tier));
const tGroupsData = Array.from(allTierNums).sort((a,b)=>a-b).map(tier=>({
  tier,
  sessions:tierSessions.filter(s=>s.tier===tier),
  tables:tierTables.filter(t=>t.tier===tier),
})).filter(g=>g.sessions.length>0||g.tables.length>0);


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 1: EXPLORER
// ═══════════════════════════════════════════════════════════════════════════════

const ExplorerView = ({selectedSession,setSelectedSession,selectedTable,setSelectedTable,filterIds}) => {
  const sel = selectedSession ? sessionData[selectedSession] : null;
  const connSessions = useMemo(()=>{
    if(!selectedTable) return new Set();
    const s=new Set();
    Object.entries(sessionData).forEach(([n,d])=>{if(d.sources.includes(selectedTable)||d.targets.includes(selectedTable)||d.lookups.includes(selectedTable))s.add(n);});
    return s;
  },[selectedTable]);

  const filteredOrder = useMemo(()=>{
    if(!filterIds) return executionOrder;
    return executionOrder.filter(n=>{const d=sessionData[n];return d&&filterIds.has("S"+d.step)||filterIds.has(n);});
  },[filterIds]);

  const Badge = ({name,type,onClick:oc}) => {
    const cm={write:C.write,read:C.read,lookup:C.lookup};
    const bm={write:"rgba(239,68,68,0.08)",read:"rgba(34,197,94,0.08)",lookup:"rgba(245,158,11,0.08)"};
    const hi=selectedTable===name;
    return <span onClick={oc} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10,fontFamily:"'JetBrains Mono',monospace",padding:"3px 8px",borderRadius:5,background:hi?"rgba(59,130,246,0.2)":bm[type]||"transparent",color:hi?C.accentBlue:cm[type]||C.textMuted,border:"1px solid "+(hi?"rgba(59,130,246,0.4)":type==="write"&&writeConflicts[name]?"rgba(239,68,68,0.5)":"transparent"),cursor:"pointer",fontWeight:hi?700:500,whiteSpace:"nowrap"}}>{type==="write"&&writeConflicts[name]&&<span style={{color:C.conflict}}>⚠ </span>}{name}</span>;
  };

  return (
    <div style={{display:"flex",gap:16,height:"100%",overflow:"hidden"}}>
      <div style={{width:320,flexShrink:0,display:"flex",flexDirection:"column",gap:8,overflowY:"auto",paddingRight:8}}>
        <div style={{fontSize:10,fontWeight:700,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.1em",padding:"0 4px",marginBottom:4}}>Sessions ({filteredOrder.length})</div>
        {filteredOrder.map(name=>{
          const d=sessionData[name]; if(!d)return null; const isSel=selectedSession===name;
          const isHi=selectedTable&&connSessions.has(name); const dim=selectedTable&&!connSessions.has(name);
          return (
            <div key={name} onClick={()=>{setSelectedSession(p=>p===name?null:name);setSelectedTable(null);}}
              style={{background:isSel?"rgba(59,130,246,0.15)":isHi?"rgba(59,130,246,0.06)":C.surface,border:"1px solid "+(isSel?C.borderActive:isHi?"rgba(59,130,246,0.3)":C.border),borderRadius:10,padding:"12px 16px",cursor:"pointer",opacity:dim?0.3:1,transition:"all 0.2s",position:"relative",overflow:"hidden"}}>
              {isSel&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,#3b82f6,#8b5cf6)"}}/>}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:700,color:isSel?C.accentBlue:C.text}}>{d.short}</div>
                  <div style={{fontSize:9,color:C.textDim,marginTop:3,fontFamily:"monospace"}}>Step {d.step} · Tier {d.tier}</div>
                </div>
                <div style={{display:"flex",gap:4,flexShrink:0}}>
                  {d.sources.length>0&&<span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(34,197,94,0.1)",color:C.read,fontWeight:600}}>{d.sources.length}R</span>}
                  {d.targets.length>0&&<span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(239,68,68,0.1)",color:C.write,fontWeight:600}}>{d.targets.length}W</span>}
                  {d.lookups.length>0&&<span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(245,158,11,0.1)",color:C.lookup,fontWeight:600}}>{d.lookups.length}L</span>}
                </div>
              </div>
              <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
                <span style={{fontSize:8,color:C.textDim,background:"rgba(255,255,255,0.03)",padding:"1px 5px",borderRadius:3}}>{d.transforms} transforms</span>
                {d.extReads>0&&<span style={{fontSize:8,color:C.textDim,background:"rgba(255,255,255,0.03)",padding:"1px 5px",borderRadius:3}}>{d.extReads} ext reads</span>}
                {d.lookupCount>0&&<span style={{fontSize:8,color:C.textDim,background:"rgba(255,255,255,0.03)",padding:"1px 5px",borderRadius:3}}>{d.lookupCount} lookups</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{flex:1,overflowY:"auto",paddingRight:4}}>
        {sel ? (
          <div>
            <div style={{marginBottom:16}}><div style={{fontSize:14,fontWeight:700,color:C.text,fontFamily:"'JetBrains Mono',monospace"}}>{sel.short}</div><div style={{fontSize:10,color:C.textDim,fontFamily:"monospace",marginTop:2}}>{selectedSession}</div></div>
            {[{label:"WRITES TO",items:sel.targets,type:"write",color:C.write},{label:"READS FROM",items:sel.sources,type:"read",color:C.read},{label:"LOOKUPS",items:sel.lookups,type:"lookup",color:C.lookup}].filter(g=>g.items.length>0).map(g=>(
              <div key={g.label} style={{marginBottom:16}}>
                <div style={{fontSize:10,fontWeight:700,color:g.color,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8,display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:"50%",background:g.color}}/>{g.label} ({g.items.length})</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>{g.items.map((t,i)=>(<Badge key={t+i} name={t} type={g.type} onClick={()=>{setSelectedTable(p=>p===t?null:t);setSelectedSession(null);}}/>))}</div>
              </div>
            ))}
            {sel.targets.some(t=>readAfterWrite[t])&&(
              <div style={{background:"rgba(168,85,247,0.06)",border:"1px solid rgba(168,85,247,0.2)",borderRadius:8,padding:12}}>
                <div style={{fontSize:10,fontWeight:700,color:C.chain,marginBottom:6}}>⛓ DOWNSTREAM CONSUMERS</div>
                {sel.targets.filter(t=>readAfterWrite[t]).map(t=>(<div key={t} style={{fontSize:10,color:C.textMuted,marginBottom:4}}><span style={{color:C.write}}>{t}</span> → {readAfterWrite[t].readers.map((r,i)=>(<span key={r}><span style={{color:C.accentBlue,cursor:"pointer"}} onClick={()=>{setSelectedSession(r);setSelectedTable(null);}}>{sessionData[r]?.short||r}</span>{i<readAfterWrite[t].readers.length-1?", ":""}</span>))}</div>))}
              </div>
            )}
          </div>
        ) : selectedTable ? (
          <div>
            <div style={{fontSize:14,fontWeight:700,color:C.text,fontFamily:"'JetBrains Mono',monospace",marginBottom:8}}>{selectedTable}</div>
            {writeConflicts[selectedTable]&&<div style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:10,marginBottom:12}}><div style={{fontSize:10,fontWeight:700,color:C.conflict,marginBottom:4}}>⚠ WRITE-WRITE CONFLICT</div><div style={{fontSize:10,color:C.textMuted}}>Writers: {writeConflicts[selectedTable].map(s=>sessionData[s]?.short||s).join(", ")}</div></div>}
            {allTables[selectedTable]&&["writes","reads","lookups"].map(rel=>{const items=allTables[selectedTable][rel];if(!items||!items.length)return null;const colors={writes:C.write,reads:C.read,lookups:C.lookup};return(<div key={rel} style={{marginBottom:8}}><span style={{fontSize:9,color:colors[rel],fontWeight:700,textTransform:"uppercase"}}>{rel}: </span>{items.map(s=>(<span key={s} onClick={()=>{setSelectedSession(s);setSelectedTable(null);}} style={{fontSize:10,color:C.accentBlue,cursor:"pointer",marginRight:8}}>{sessionData[s]?.short||s}</span>))}</div>);})}
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",opacity:0.4}}>
            <div style={{fontSize:32,marginBottom:12}}>←</div><div style={{fontSize:12,color:C.textMuted,textAlign:"center"}}>Select a session to explore</div>
          </div>
        )}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 2: CONFLICTS & CHAINS
// ═══════════════════════════════════════════════════════════════════════════════

const ConflictsView = ({filterIds}) => {
  const sessionNames = useMemo(()=>{
    if(!filterIds) return null;
    const s=new Set();
    Object.entries(sessionData).forEach(([n,d])=>{if(filterIds.has("S"+d.step)||filterIds.has(n))s.add(n);});
    return s;
  },[filterIds]);

  const filteredConflicts = useMemo(()=>{
    if(!sessionNames) return writeConflicts;
    const r={};
    Object.entries(writeConflicts).forEach(([t,w])=>{const fw=w.filter(s=>sessionNames.has(s));if(fw.length>1)r[t]=fw;});
    return r;
  },[sessionNames]);

  const filteredChains = useMemo(()=>{
    if(!sessionNames) return readAfterWrite;
    const r={};
    Object.entries(readAfterWrite).forEach(([t,{writers:w,readers:rd}])=>{
      const fw=w.filter(s=>sessionNames.has(s));const fr=rd.filter(s=>sessionNames.has(s));
      if(fw.length>0&&fr.length>0)r[t]={writers:fw,readers:fr};
    });
    return r;
  },[sessionNames]);

  return (
    <div style={{overflowY:"auto",height:"100%"}}>
      <div style={{marginBottom:24}}>
        <div style={{fontSize:13,fontWeight:700,color:C.conflict,marginBottom:4,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>⚠</span> Write-Write Conflicts ({Object.keys(filteredConflicts).length})</div>
        <div style={{fontSize:10,color:C.textDim,marginBottom:12}}>Multiple sessions writing to the same target — validation depends on execution order</div>
        {Object.entries(filteredConflicts).map(([t,w])=>(<div key={t} style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:8,padding:14,marginBottom:10}}><div style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.write,marginBottom:8}}>{t}</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{w.map(s=>(<span key={s} style={{fontSize:10,padding:"4px 10px",borderRadius:5,background:C.surface,color:C.text,border:"1px solid "+C.border}}>{sessionData[s]?.short||s}</span>))}</div></div>))}
      </div>
      <div style={{marginBottom:24}}>
        <div style={{fontSize:13,fontWeight:700,color:C.chain,marginBottom:4,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>⛓</span> Read-After-Write Chains ({Object.keys(filteredChains).length})</div>
        <div style={{fontSize:10,color:C.textDim,marginBottom:12}}>Reader MUST run after writer</div>
        {Object.entries(filteredChains).map(([t,{writers:w,readers:r}])=>(<div key={t} style={{background:"rgba(168,85,247,0.06)",border:"1px solid rgba(168,85,247,0.2)",borderRadius:8,padding:14,marginBottom:10}}><div style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.chain,marginBottom:10}}>{t}</div><div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}><div><div style={{fontSize:8,color:C.textDim,textTransform:"uppercase",marginBottom:4}}>Writers</div><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{w.map(x=>(<span key={x} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"rgba(239,68,68,0.1)",color:C.write,fontFamily:"monospace"}}>{sessionData[x]?.short||x}</span>))}</div></div><div style={{fontSize:18,color:C.chain}}>→</div><div><div style={{fontSize:8,color:C.textDim,textTransform:"uppercase",marginBottom:4}}>Readers</div><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{r.map(x=>(<span key={x} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"rgba(34,197,94,0.1)",color:C.read,fontFamily:"monospace"}}>{sessionData[x]?.short||x}</span>))}</div></div></div></div>))}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 3: EXECUTION ORDER
// ═══════════════════════════════════════════════════════════════════════════════

const OrderView = ({filterIds}) => {
  const filteredOrder = useMemo(()=>{
    if(!filterIds) return executionOrder;
    return executionOrder.filter(n=>{const d=sessionData[n];return d&&(filterIds.has("S"+d.step)||filterIds.has(n));});
  },[filterIds]);

  return (
    <div style={{overflowY:"auto",height:"100%"}}>
      <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>Recommended Execution Order</div>
      <div style={{fontSize:10,color:C.textDim,marginBottom:16}}>Respects all read-after-write chains and write conflicts</div>
      {filteredOrder.map((name,i)=>{const s=sessionData[name];if(!s)return null;const hc=s.targets.some(t=>writeConflicts[t]);const hch=s.targets.some(t=>readAfterWrite[t]);return(
        <div key={name} style={{display:"flex",alignItems:"stretch",marginBottom:2}}>
          <div style={{width:48,display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0}}>
            <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:hc?"rgba(239,68,68,0.15)":hch?"rgba(168,85,247,0.15)":"rgba(59,130,246,0.15)",border:"2px solid "+(hc?C.conflict:hch?C.chain:"#3b82f6"),fontSize:11,fontWeight:700,color:hc?C.conflict:hch?C.chain:"#3b82f6",fontFamily:"monospace"}}>{i+1}</div>
            {i<filteredOrder.length-1&&<div style={{flex:1,width:2,background:C.border,minHeight:24}}/>}
          </div>
          <div style={{flex:1,background:C.surface,border:"1px solid "+C.border,borderRadius:8,padding:"10px 14px",marginBottom:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontSize:11,fontWeight:700,color:C.text,fontFamily:"'JetBrains Mono',monospace"}}>{s.short}</div><div style={{fontSize:9,color:C.textDim,marginTop:2}}>writes → {s.targets.join(", ")||"(none)"}</div></div>
              <div style={{display:"flex",gap:4}}>{hc&&<span style={{fontSize:8,padding:"2px 6px",borderRadius:4,background:"rgba(239,68,68,0.1)",color:C.conflict,fontWeight:700}}>CONFLICT</span>}{hch&&<span style={{fontSize:8,padding:"2px 6px",borderRadius:4,background:"rgba(168,85,247,0.1)",color:C.chain,fontWeight:700}}>CHAIN</span>}</div>
            </div>
          </div>
        </div>
      );})}
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 4: TIER DIAGRAM
// ═══════════════════════════════════════════════════════════════════════════════

const TierDiagram = ({filterIds}) => {
  const containerRef = useRef(null);
  const nodeRefs = useRef({});
  const [lines,setLines] = useState([]);
  const [svgDims,setSvgDims] = useState({w:0,h:0});
  const [hov,setHov] = useState(null);
  const [sel,setSel] = useState(null);
  const [hiddenTiers,setHiddenTiers] = useState(()=>new Set());
  const regRef = useCallback((id,el)=>{if(el)nodeRefs.current[id]=el;},[]);

  const filteredSessions = useMemo(()=>filterIds?tierSessions.filter(s=>filterIds.has(s.id)):tierSessions,[filterIds]);
  const filteredTables = useMemo(()=>{
    if(!filterIds) return tierTables;
    const sessionIds=new Set(filteredSessions.map(s=>s.id));
    const tableIds=new Set();
    tierConnections.forEach(c=>{if(sessionIds.has(c.from))tableIds.add(c.to);if(sessionIds.has(c.to))tableIds.add(c.from);});
    return tierTables.filter(t=>tableIds.has(t.id));
  },[filterIds,filteredSessions]);

  const nodeTierMap = useMemo(()=>{
    const m=new Map();
    filteredSessions.forEach(s=>m.set(s.id,s.tier));
    filteredTables.forEach(t=>m.set(t.id,t.tier));
    return m;
  },[filteredSessions,filteredTables]);

  const activeConns = useMemo(()=>
    tierConnections.filter(cn=>{
      const fT=nodeTierMap.get(cn.from);
      const tT=nodeTierMap.get(cn.to);
      return fT!==undefined&&!hiddenTiers.has(fT)&&tT!==undefined&&!hiddenTiers.has(tT);
    })
  ,[hiddenTiers,nodeTierMap]);

  const allTierNumsLocal = new Set();
  filteredSessions.forEach(s=>allTierNumsLocal.add(s.tier));
  filteredTables.forEach(t=>allTierNumsLocal.add(t.tier));
  const tGroupsLocal = Array.from(allTierNumsLocal).sort((a,b)=>a-b).map(tier=>({
    tier,
    sessions:filteredSessions.filter(s=>s.tier===tier),
    tables:filteredTables.filter(t=>t.tier===tier),
  })).filter(g=>g.sessions.length>0||g.tables.length>0);

  const visibleGroups = useMemo(()=>tGroupsLocal.filter(g=>!hiddenTiers.has(g.tier)),[hiddenTiers,tGroupsLocal]);

  const connCounts = useMemo(()=>{const c={};activeConns.forEach(cn=>{c[cn.from]=(c[cn.from]||0)+1;c[cn.to]=(c[cn.to]||0)+1;});return c;},[activeConns]);

  const recalc = useCallback(()=>{
    if(!containerRef.current) return;
    const el=containerRef.current;
    const cr=el.getBoundingClientRect();
    const st=el.scrollTop, sl=el.scrollLeft;
    setSvgDims({w:el.scrollWidth,h:el.scrollHeight});
    const groups={};
    activeConns.forEach((cn,ci)=>{
      const fE=nodeRefs.current[cn.from],tE=nodeRefs.current[cn.to];
      if(!fE||!tE) return;
      const fR=fE.getBoundingClientRect(),tR=tE.getBoundingClientRect();
      const down=fR.top<tR.top;
      const key=down?cn.from+"-"+cn.to:cn.to+"-"+cn.from;
      if(!groups[key]) groups[key]={conns:[],count:0};
      groups[key].conns.push(ci);
      groups[key].count++;
    });
    const newLines = activeConns.map((cn,ci)=>{
      const fE=nodeRefs.current[cn.from],tE=nodeRefs.current[cn.to];
      if(!fE||!tE) return null;
      const fR=fE.getBoundingClientRect(),tR=tE.getBoundingClientRect();
      const down=fR.top<tR.top;
      let fX=fR.left+fR.width/2-cr.left+sl;
      let fY=down?fR.bottom-cr.top+st:fR.top-cr.top+st;
      let tX=tR.left+tR.width/2-cr.left+sl;
      let tY=down?tR.top-cr.top+st:tR.bottom-cr.top+st;
      const key=down?cn.from+"-"+cn.to:cn.to+"-"+cn.from;
      const g=groups[key];
      if(g&&g.count>1){const off=(g.conns.indexOf(ci)-(g.count-1)/2)*14;fX+=off;tX+=off;}
      const ct=connTypes[cn.type]||connTypes.write_clean;
      const th=ct.baseWidth*(1+Math.min(connCounts[cn.from]||1,7)*0.12);
      const isAct=hov===cn.from||hov===cn.to||sel===cn.from||sel===cn.to;
      const isDim=(hov||sel)&&!isAct;
      return{fX,fY,tX,tY,color:ct.color,dash:ct.dash,th,isAct,isDim,type:cn.type};
    }).filter(Boolean);
    setLines(newLines);
  },[hov,sel,connCounts,activeConns]);

  useEffect(()=>{const t=setTimeout(recalc,80);return()=>clearTimeout(t);},[recalc]);
  useEffect(()=>{
    const el=containerRef.current;if(!el)return;
    el.addEventListener("scroll",recalc);window.addEventListener("resize",recalc);
    return()=>{el.removeEventListener("scroll",recalc);window.removeEventListener("resize",recalc);};
  },[recalc]);

  const tStyle={conflict:{bg:"rgba(239,68,68,0.12)",border:"#EF4444",color:"#FCA5A5",icon:"⚠"},chain:{bg:"rgba(249,115,22,0.10)",border:"#F97316",color:"#FDBA74",icon:"⛓"},independent:{bg:"rgba(34,197,94,0.08)",border:"#22C55E",color:"#86EFAC",icon:"✓"},source:{bg:"rgba(16,185,129,0.08)",border:"#10B981",color:"#6EE7B7",icon:"↓"}};
  const isConn = (id)=> activeConns.some(c=>(c.from===id&&(c.to===hov||c.to===sel))||(c.to===id&&(c.from===hov||c.from===sel)));

  return (
    <div style={{display:"flex",height:"100%",overflow:"hidden"}}>
      <div ref={containerRef} style={{flex:1,overflowY:"auto",overflowX:"auto",position:"relative"}}>
        <svg style={{position:"absolute",top:0,left:0,pointerEvents:"none",zIndex:1,overflow:"visible"}} width={svgDims.w||undefined} height={svgDims.h||undefined}>
          <defs>{Object.entries(connTypes).map(([k,v])=>(<marker key={k} id={"arr-"+k} viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="7" markerHeight="6" orient="auto"><path d="M0,0.5 L9,3.5 L0,6.5" fill={v.color}/></marker>))}</defs>
          {lines.map((l,i)=>{
            const dy=l.tY-l.fY;const cp=Math.max(Math.abs(dy)*0.35,30);const cpx=(l.tX-l.fX)*0.15;
            const path="M"+l.fX+","+l.fY+" C"+(l.fX+cpx)+","+(l.fY+(dy>0?cp:-cp))+" "+(l.tX-cpx)+","+(l.tY-(dy>0?cp:-cp))+" "+l.tX+","+l.tY;
            return <path key={i} d={path} fill="none" stroke={l.color} strokeWidth={l.isAct?l.th*1.6:l.th} strokeDasharray={l.dash||undefined} opacity={l.isDim?0.08:l.isAct?1:0.45} markerEnd={"url(#arr-"+l.type+")"} style={{transition:"opacity 0.15s"}}/>;
          })}
        </svg>
        <div style={{position:"relative",padding:"28px 40px",minWidth:920,zIndex:2}}>
          {visibleGroups.map((g,gi)=>{const cfg=getTierCfg(g.tier);return(
            <div key={gi} style={{background:cfg.bgAlpha,border:"1px solid "+cfg.border+"33",borderRadius:12,padding:"22px 28px",marginBottom:18}}>
              <div style={{fontSize:10,fontWeight:800,color:cfg.color,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:4,height:16,borderRadius:2,background:cfg.color}}/>{cfg.label}
                <span style={{marginLeft:"auto",fontSize:9,color:cfg.color,opacity:0.6,fontFamily:"monospace"}}>
                  {g.sessions.length>0&&g.sessions.length+" session"+(g.sessions.length>1?"s":"")}
                  {g.sessions.length>0&&g.tables.length>0&&" · "}
                  {g.tables.length>0&&g.tables.length+" table"+(g.tables.length>1?"s":"")}
                </span>
              </div>
              <div style={{display:"flex",gap:20,flexWrap:"wrap",justifyContent:"center"}}>
                {g.sessions.map(s=>(
                  <div key={s.id} ref={el=>regRef(s.id,el)} onMouseEnter={()=>setHov(s.id)} onMouseLeave={()=>setHov(null)} onClick={()=>setSel(p=>p===s.id?null:s.id)}
                    style={{background:(hov===s.id||sel===s.id)?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.3)",border:(s.critical?2:1)+"px solid "+(sel===s.id?"#fff":hov===s.id?cfg.color:s.critical?"#EF4444":cfg.border),borderRadius:8,padding:"12px 16px",cursor:"pointer",minWidth:190,position:"relative",boxShadow:s.critical?"0 0 12px rgba(239,68,68,0.2)":"none",transition:"all 0.15s",opacity:(hov||sel)&&hov!==s.id&&sel!==s.id&&!isConn(s.id)?0.3:1}}>
                    {s.critical&&<div style={{position:"absolute",top:-8,right:-8,background:"#EF4444",color:"#fff",fontSize:8,fontWeight:800,padding:"2px 5px",borderRadius:4}}>⚠</div>}
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <div style={{width:22,height:22,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:cfg.color,fontSize:10,fontWeight:800,color:"#fff",fontFamily:"monospace",flexShrink:0}}>{s.step}</div>
                      <div style={{fontSize:11,fontWeight:700,color:"#E2E8F0",fontFamily:"'JetBrains Mono',monospace"}}>{s.name}</div>
                    </div>
                    <div style={{fontSize:9,color:"#94A3B8",fontFamily:"monospace",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:200}}>{s.full}</div>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {s.transforms>0&&<span style={{fontSize:9,padding:"2px 5px",borderRadius:3,background:"rgba(59,130,246,0.12)",color:"#60A5FA"}}>{s.transforms} tx</span>}
                      {s.extReads>0&&<span style={{fontSize:9,padding:"2px 5px",borderRadius:3,background:"rgba(107,114,128,0.15)",color:"#9CA3AF"}}>{s.extReads} rd</span>}
                      {s.lookupCount>0&&<span style={{fontSize:9,padding:"2px 5px",borderRadius:3,background:"rgba(245,158,11,0.12)",color:"#FBBF24"}}>{s.lookupCount} lkp</span>}
                    </div>
                  </div>
                ))}
                {g.tables.map(t=>{const ts=tStyle[t.type]||tStyle.independent;return(
                  <div key={t.id} ref={el=>regRef(t.id,el)} onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)} onClick={()=>setSel(p=>p===t.id?null:t.id)}
                    style={{background:(hov===t.id||sel===t.id)?"rgba(255,255,255,0.08)":ts.bg,border:(t.type==="conflict"?2:1)+"px solid "+(sel===t.id?"#fff":hov===t.id?"#fff":ts.border),borderRadius:6,padding:"10px 14px",cursor:"pointer",minWidth:148,textAlign:"center",boxShadow:t.type==="conflict"?"0 0 16px rgba(239,68,68,0.25)":"none",transition:"all 0.15s",opacity:(hov||sel)&&hov!==t.id&&sel!==t.id&&!isConn(t.id)?0.3:1}}>
                    <div style={{fontSize:13,marginBottom:2}}>{ts.icon}</div>
                    <div style={{fontSize:10,fontWeight:700,color:ts.color,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.2,wordBreak:"break-all"}}>{t.name}</div>
                    {(t.type==="conflict"||t.readers>0||t.lookupUsers>0)&&<div style={{fontSize:8,color:ts.color,marginTop:3,fontWeight:600,opacity:0.8}}>{t.type==="conflict"?t.conflictWriters+"W":""}{t.readers>0?" "+t.readers+"R":""}{t.lookupUsers>0?" "+t.lookupUsers+"L":""}</div>}
                    <div style={{fontSize:8,color:"#8899aa",marginTop:2,textTransform:"uppercase",letterSpacing:"0.05em"}}>{t.type}</div>
                  </div>
                );})}
              </div>
            </div>
          );})}
        </div>
      </div>
      <div style={{width:260,borderLeft:"1px solid #3a4a5e",background:"rgba(26,35,50,0.6)",overflowY:"auto",flexShrink:0,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid #3a4a5e",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:10,fontWeight:700,color:"#8899aa",textTransform:"uppercase",letterSpacing:"0.1em"}}>Tier Visibility</div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>setHiddenTiers(new Set())} style={{fontSize:8,padding:"2px 6px",borderRadius:3,border:"1px solid #3a4a5e",background:"transparent",color:"#8899aa",cursor:"pointer"}}>All</button>
              <button onClick={()=>setHiddenTiers(new Set(tGroupsLocal.map(g=>g.tier)))} style={{fontSize:8,padding:"2px 6px",borderRadius:3,border:"1px solid #3a4a5e",background:"transparent",color:"#8899aa",cursor:"pointer"}}>None</button>
            </div>
          </div>
          {tGroupsLocal.map(g=>{
            const cfg=getTierCfg(g.tier);
            const hidden=hiddenTiers.has(g.tier);
            const toggle=()=>setHiddenTiers(prev=>{const next=new Set(prev);next.has(g.tier)?next.delete(g.tier):next.add(g.tier);return next;});
            return(
              <div key={g.tier} onClick={toggle} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5,cursor:"pointer",userSelect:"none",overflow:"hidden"}}>
                <div style={{width:16,height:16,minWidth:16,borderRadius:3,flexShrink:0,border:"2px solid "+(hidden?"#5a6a7a":cfg.color),background:hidden?"transparent":cfg.color,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s"}}>
                  {!hidden&&<span style={{color:"#fff",fontSize:9,fontWeight:900,lineHeight:1}}>✓</span>}
                </div>
                <div style={{fontSize:8,color:hidden?"#5a6a7a":"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",width:0,flexGrow:1,transition:"color 0.15s"}}>{cfg.label}</div>
                <div style={{fontSize:8,fontFamily:"monospace",color:hidden?"#5a6a7a":cfg.color,flexShrink:0,whiteSpace:"nowrap"}}>
                  {g.sessions.length>0?g.sessions.length+"S":""}{g.sessions.length>0&&g.tables.length>0?"+":""}{g.tables.length>0?g.tables.length+"T":""}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{padding:"12px 14px",borderBottom:"1px solid #3a4a5e",flexShrink:0}}><div style={{fontSize:10,fontWeight:700,color:"#8899aa",textTransform:"uppercase",letterSpacing:"0.1em"}}>Node Detail</div></div>
        {sel?(()=>{const s=filteredSessions.find(x=>x.id===sel);const t=filteredTables.find(x=>x.id===sel);const nd=s||t;if(!nd)return null;const outs=activeConns.filter(c=>c.from===sel);const ins=activeConns.filter(c=>c.to===sel);return(
          <div style={{padding:14,flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:"#E2E8F0",fontFamily:"'JetBrains Mono',monospace",marginBottom:4}}>{nd.name}</div>
            {s&&<div style={{fontSize:9,color:"#8899aa",marginBottom:12,fontFamily:"monospace",wordBreak:"break-all"}}>{s.full}</div>}
            {t&&<div style={{fontSize:9,color:"#8899aa",marginBottom:12}}>{t.type} · tier {t.tier}</div>}
            {outs.length>0&&<div style={{marginBottom:12}}><div style={{fontSize:9,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",marginBottom:6}}>Outputs → ({outs.length})</div>{outs.map((c,i)=>{const tgt=[...filteredSessions,...filteredTables].find(x=>x.id===c.to);const ct=connTypes[c.type]||connTypes.write_clean;return(<div key={i} style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}><div style={{width:8,height:3,borderRadius:1,background:ct.color,flexShrink:0}}/><span style={{fontSize:9,color:ct.color,fontWeight:600,flexShrink:0}}>{c.type.replace(/_/g," ")}</span><span style={{fontSize:9,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>→ {tgt?.name||c.to}</span></div>);})}</div>}
            {ins.length>0&&<div style={{marginBottom:12}}><div style={{fontSize:9,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",marginBottom:6}}>Inputs ← ({ins.length})</div>{ins.map((c,i)=>{const src=[...filteredSessions,...filteredTables].find(x=>x.id===c.from);const ct=connTypes[c.type]||connTypes.write_clean;return(<div key={i} style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}><div style={{width:8,height:3,borderRadius:1,background:ct.color,flexShrink:0}}/><span style={{fontSize:9,color:ct.color,fontWeight:600,flexShrink:0}}>{c.type.replace(/_/g," ")}</span><span style={{fontSize:9,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>← {src?.name||c.from}</span></div>);})}</div>}
          </div>
        );})():<div style={{padding:20,color:"#5a6a7a",fontSize:11,textAlign:"center",flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}>Click a node to inspect</div>}
        <div style={{padding:"10px 14px",borderTop:"1px solid #3a4a5e",flexShrink:0}}>
          <div style={{fontSize:9,fontWeight:700,color:"#8899aa",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Connection Density</div>
          {[...filteredSessions,...filteredTables].filter(n=>(connCounts[n.id]||0)>0).sort((a,b)=>(connCounts[b.id]||0)-(connCounts[a.id]||0)).slice(0,12).map(n=>(
            <div key={n.id} style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
              <div style={{fontSize:8,color:"#8899aa",width:12,textAlign:"right",fontFamily:"monospace"}}>{connCounts[n.id]||0}</div>
              <div style={{flex:1,height:5,borderRadius:2,background:"#3a4a5e",overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,width:Math.min((connCounts[n.id]||0)/8*100,100)+"%",background:(connCounts[n.id]||0)>4?"#EF4444":(connCounts[n.id]||0)>2?"#F59E0B":"#3B82F6"}}/></div>
              <div style={{fontSize:8,color:"#94A3B8",fontFamily:"monospace",width:85,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 5: RELATIONSHIP MATRIX
// ═══════════════════════════════════════════════════════════════════════════════

const MatrixView = ({filterIds}) => {
  const [hov,setHov] = useState(null);
  const cl=(t)=>({write_conflict:"W⚠",write_clean:"W",read_after_write:"R",lookup_stale:"L",chain:"⛓",source_read:"SR"}[t]||"?");

  const filteredSessions = useMemo(()=>{
    if(!filterIds) return tierSessions;
    return tierSessions.filter(s=>filterIds.has(s.id));
  },[filterIds]);

  const filteredTables = useMemo(()=>{
    if(!filterIds) return tierTables;
    const sessionIds=new Set(filteredSessions.map(s=>s.id));
    const tableIds=new Set();
    tierConnections.forEach(c=>{if(sessionIds.has(c.from))tableIds.add(c.to);if(sessionIds.has(c.to))tableIds.add(c.from);});
    return tierTables.filter(t=>tableIds.has(t.id));
  },[filterIds,filteredSessions]);

  return (
    <div style={{height:"100%",overflow:"auto",padding:24}}>
      <div style={{fontSize:18,fontWeight:700,color:"#E2E8F0",marginBottom:6}}>Many-to-Many Relationship Matrix</div>
      <div style={{fontSize:14,color:"#8899aa",marginBottom:16}}>Sessions (rows) × Tables (columns) — hover to highlight</div>
      <div style={{display:"flex",gap:16,marginBottom:20,flexWrap:"wrap"}}>
        {Object.entries(connTypes).map(([k,ct])=>(<div key={k} style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:36,height:28,borderRadius:5,fontSize:14,fontWeight:800,background:ct.color+"33",color:ct.color,border:"1px solid "+ct.color+"66",display:"flex",alignItems:"center",justifyContent:"center"}}>{cl(k)}</div><span style={{fontSize:13,color:"#94A3B8"}}>{ct.label}</span></div>))}
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{borderCollapse:"collapse",fontSize:14,fontFamily:"'JetBrains Mono',monospace"}}>
          <thead><tr>
            <th style={{padding:"10px 16px",background:"#3a4a5e",color:"#8899aa",position:"sticky",left:0,zIndex:2,textAlign:"left",borderBottom:"2px solid #4a5a6e",fontSize:13}}>Session ↓ / Table →</th>
            {filteredTables.map(t=>(<th key={t.id} onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)} style={{padding:"8px 8px",background:hov===t.id?"rgba(255,255,255,0.1)":"#3a4a5e",color:hov===t.id?"#fff":"#94A3B8",cursor:"pointer",writingMode:"vertical-lr",textOrientation:"mixed",minWidth:48,borderBottom:"2px solid #4a5a6e",borderRight:"1px solid #1a1f2e",fontWeight:t.type==="conflict"?700:500,fontSize:13,maxHeight:200}}>{t.name}</th>))}
          </tr></thead>
          <tbody>{filteredSessions.map(s=>{const cfg=getTierCfg(s.tier);return(<tr key={s.id}>
            <td onMouseEnter={()=>setHov(s.id)} onMouseLeave={()=>setHov(null)} style={{padding:"12px 16px",background:hov===s.id?"rgba(255,255,255,0.1)":"#243044",color:hov===s.id?"#fff":cfg.color,position:"sticky",left:0,zIndex:1,cursor:"pointer",borderBottom:"1px solid #1a1f2e",fontWeight:600,whiteSpace:"nowrap",fontSize:14}}><span style={{color:"#8899aa",marginRight:6}}>S{s.step}</span>{s.name}</td>
            {filteredTables.map(t=>{const m=tierConnections.filter(c=>(c.from===s.id&&c.to===t.id)||(c.from===t.id&&c.to===s.id));const hi=hov===s.id||hov===t.id;return(
              <td key={t.id} style={{padding:5,background:m.length>0?(hi?"rgba(255,255,255,0.15)":(connTypes[m[0].type]?.color||"#3B82F6")+"18"):(hi?"rgba(255,255,255,0.02)":"transparent"),borderBottom:"1px solid #1a1f2e",borderRight:"1px solid #1a1f2e",textAlign:"center",verticalAlign:"middle"}}>
                {m.map((x,i)=>{const ct=connTypes[x.type]||connTypes.write_clean;return(<div key={i} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:38,height:32,borderRadius:5,fontSize:14,fontWeight:800,background:ct.color+"33",color:ct.color,border:"2px solid "+ct.color+"55",margin:2}}>{cl(x.type)}</div>);})}
              </td>
            );})}
          </tr>);})}</tbody>
        </table>
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 6: CONSTELLATION (SVG-based renderer matching ConstellationCanvas)
// ═══════════════════════════════════════════════════════════════════════════════

const TIER_COLORS_CONST = ['#3B82F6','#EAB308','#A855F7','#10B981','#F97316','#06B6D4','#EC4899','#84CC16'];
function tierColorConst(t){return TIER_COLORS_CONST[Math.max(0,Math.floor(t)-1)%TIER_COLORS_CONST.length];}

const ALGO_META_CONST = {
  louvain:{name:"Louvain",icon:"\u25CE",desc:"Modularity-based community detection"},
  tier:{name:"Tier Groups",icon:"\u2261",desc:"Group sessions by execution tier"},
  components:{name:"Connected Components",icon:"\u25C7",desc:"Natural graph islands"},
  label_prop:{name:"Label Propagation",icon:"\u21B9",desc:"Fast iterative label spreading"},
  greedy_mod:{name:"Greedy Modularity",icon:"\u25A3",desc:"Agglomerative merge"},
  process_group:{name:"Process Group",icon:"\u229E",desc:"Group by process group / workflow"},
  table_gravity:{name:"Table Gravity",icon:"\u2299",desc:"Cluster around most-referenced tables"},
  gradient_scale:{name:"Gradient Scale",icon:"\u25D0",desc:"Density heatmap with peak markers"},
};
const ALGO_KEYS_CONST = Object.keys(ALGO_META_CONST);

const ConstellationView = ({onSelectCluster,selectedClusterId}) => {
  const [clusterSearch,setClusterSearch] = useState("");
  const [sortBy,setSortBy] = useState("default");
  const [hov,setHov] = useState(null);
  const [highlighted,setHighlighted] = useState(new Set());
  const [activeChunkIds,setActiveChunkIds] = useState(new Set());
  const svgRef = useRef(null);
  const [transform,setTransform] = useState({x:0,y:0,k:1});
  const dragRef = useRef(null);
  const [showEdges,setShowEdges] = useState(true);
  const [showHulls,setShowHulls] = useState(true);
  const [showSessionSearch,setShowSessionSearch] = useState(false);
  const [sessionSearch,setSessionSearch] = useState("");
  const [focusedSessionId,setFocusedSessionId] = useState(null);
  const activeAlgo = (constellationChunks[0]||{}).id ? "louvain" : "louvain";

  const chunkMap = useMemo(()=>{const m=new Map();constellationChunks.forEach(c=>m.set(c.id,c));return m;},[]);
  const chunkColorMap = useMemo(()=>{const m=new Map();constellationChunks.forEach(c=>m.set(c.id,c.color));return m;},[]);

  // Hulls via Graham scan
  const hulls = useMemo(()=>{
    const grouped=new Map();
    constellationPoints.forEach(p=>{if(!grouped.has(p.chunk_id))grouped.set(p.chunk_id,[]);grouped.get(p.chunk_id).push(p);});
    const result=[];
    for(const[id,pts]of grouped){
      if(pts.length<3)continue;
      const sorted=[...pts].sort((a,b)=>a.x-b.x||a.y-b.y);
      const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
      const lower=[];for(const p of sorted){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();lower.push(p);}
      const upper=[];for(let i=sorted.length-1;i>=0;i--){const p=sorted[i];while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p);}
      lower.pop();upper.pop();
      const hull=[...lower,...upper];
      result.push({id,hull,color:chunkColorMap.get(id)||"#3B82F6"});
    }
    return result;
  },[chunkColorMap]);

  // Centroids for cluster labels
  const centroids = useMemo(()=>{
    const m=new Map();
    const grouped=new Map();
    constellationPoints.forEach(p=>{if(!grouped.has(p.chunk_id))grouped.set(p.chunk_id,[]);grouped.get(p.chunk_id).push(p);});
    for(const[id,pts]of grouped){
      if(pts.length<5)continue;
      m.set(id,{x:pts.reduce((a,p)=>a+p.x,0)/pts.length,y:pts.reduce((a,p)=>a+p.y,0)/pts.length});
    }
    return m;
  },[]);

  // Session-table map for linked sessions
  const sessionTableMap = useMemo(()=>{
    const map=new Map();
    const tableIdToName=new Map();tierTables.forEach(t=>tableIdToName.set(t.id,t.name));
    tierConnections.forEach(c=>{
      if(c.from.startsWith("S")){const tn=tableIdToName.get(c.to);if(tn){if(!map.has(c.from))map.set(c.from,new Set());map.get(c.from).add(tn);}}
      if(c.to.startsWith("S")){const tn=tableIdToName.get(c.from);if(tn){if(!map.has(c.to))map.set(c.to,new Set());map.get(c.to).add(tn);}}
    });
    return map;
  },[]);

  const findLinked = useCallback((sid)=>{
    const tables=sessionTableMap.get(sid);
    if(!tables||tables.size===0)return;
    const linked=new Set([sid]);
    for(const[s,st]of sessionTableMap){if(s===sid)continue;for(const t of st){if(tables.has(t)){linked.add(s);break;}}}
    setHighlighted(linked);
  },[sessionTableMap]);

  // Filtered & sorted chunks
  const filteredChunks = useMemo(()=>{
    let list = [...constellationChunks];
    if(clusterSearch.trim()){
      const q=clusterSearch.toLowerCase();
      list=list.filter(c=>c.label.toLowerCase().includes(q)||(c.pivot_tables||[]).some(t=>t.toLowerCase().includes(q)));
    }
    if(sortBy==="sessions")list.sort((a,b)=>b.session_count-a.session_count);
    else if(sortBy==="tiers")list.sort((a,b)=>(a.tier_range||[1])[0]-(b.tier_range||[1])[0]);
    else if(sortBy==="conflicts")list.sort((a,b)=>(b.conflict_count||0)-(a.conflict_count||0));
    return list;
  },[clusterSearch,sortBy]);

  // Session search results
  const sessionResults = useMemo(()=>{
    if(!sessionSearch.trim())return[];
    const q=sessionSearch.toLowerCase();
    return constellationPoints.filter(p=>p.name.toLowerCase().includes(q)).slice(0,20);
  },[sessionSearch]);

  const W=800,H=600,PAD=40;
  const sx=(nx)=>PAD+nx*(W-PAD*2);
  const sy=(ny)=>PAD+ny*(H-PAD*2);

  // Mouse wheel zoom
  const handleWheel = useCallback((e)=>{
    e.preventDefault();
    const factor=e.deltaY>0?0.9:1.1;
    const svg=svgRef.current;if(!svg)return;
    const rect=svg.getBoundingClientRect();
    const mx=e.clientX-rect.left;const my=e.clientY-rect.top;
    setTransform(prev=>{
      const nk=Math.max(0.3,Math.min(20,prev.k*factor));
      const nx=mx-(mx-prev.x)*nk/prev.k;
      const ny=my-(my-prev.y)*nk/prev.k;
      return{x:nx,y:ny,k:nk};
    });
  },[]);

  const handleMouseDown = useCallback((e)=>{
    if(e.target.tagName==="circle"||e.target.tagName==="polygon"||e.target.tagName==="text")return;
    dragRef.current={startX:e.clientX-transform.x,startY:e.clientY-transform.y};
  },[transform]);
  const handleMouseMove = useCallback((e)=>{
    if(!dragRef.current)return;
    setTransform(prev=>({...prev,x:e.clientX-dragRef.current.startX,y:e.clientY-dragRef.current.startY}));
  },[]);
  const handleMouseUp = useCallback(()=>{dragRef.current=null;},[]);

  const hasHighlight=highlighted.size>0;
  const hasFilter=activeChunkIds.size>0;
  const criticalCount=constellationPoints.filter(p=>p.critical).length;

  const handleChunkToggle = useCallback((chunkId)=>{
    setActiveChunkIds(prev=>{
      const next=new Set(prev);
      if(next.has(chunkId))next.delete(chunkId);else next.add(chunkId);
      return next;
    });
  },[]);

  const handleSelectAll = useCallback(()=>{
    setActiveChunkIds(new Set(constellationChunks.map(c=>c.id)));
  },[]);

  const handleDeselectAll = useCallback(()=>{setActiveChunkIds(new Set());},[]);

  const allSelected = activeChunkIds.size===constellationChunks.length&&constellationChunks.length>0;

  return (
    <div style={{display:"flex",height:"100%",overflow:"hidden"}}>
      {/* ── Left sidebar: chunk selector ── */}
      <div style={{width:260,borderRight:"1px solid #3a4a5e",background:"rgba(26,35,50,0.6)",display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0}}>
        {/* Back / Clear */}
        <button onClick={hasFilter?handleDeselectAll:handleDeselectAll} style={{padding:"8px 14px",background:"transparent",border:"none",borderBottom:"1px solid #3a4a5e",cursor:"pointer",display:"flex",alignItems:"center",gap:6,color:"#60A5FA",fontSize:11,fontWeight:600}}>
          {hasFilter?"Clear Selection ("+activeChunkIds.size+")":"\u2190 Back to Constellation"}
        </button>

        {/* Search + Sort */}
        <div style={{padding:"8px 10px",borderBottom:"1px solid #3a4a5e"}}>
          <input type="text" placeholder="Filter clusters\u2026" value={clusterSearch} onChange={e=>setClusterSearch(e.target.value)}
            style={{width:"100%",padding:"5px 10px",borderRadius:5,border:"1px solid #3a4a5e",background:"rgba(0,0,0,0.3)",color:"#E2E8F0",fontSize:11,outline:"none",fontFamily:"'JetBrains Mono',monospace"}}/>
          <div style={{display:"flex",gap:4,marginTop:6,flexWrap:"wrap"}}>
            {[["default","Default"],["sessions","Sessions"],["tiers","Tier"],["conflicts","Conflicts"]].map(([key,label])=>(
              <button key={key} onClick={()=>setSortBy(key)} style={{padding:"2px 6px",borderRadius:3,border:"none",cursor:"pointer",background:sortBy===key?"rgba(59,130,246,0.15)":"rgba(255,255,255,0.03)",color:sortBy===key?"#60A5FA":"#5a6a7a",fontSize:9,fontWeight:600}}>{label}</button>
            ))}
          </div>
        </div>

        {/* Session search */}
        <div style={{borderBottom:"1px solid #3a4a5e"}}>
          <button onClick={()=>setShowSessionSearch(s=>!s)} style={{width:"100%",padding:"6px 10px",background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:6,color:showSessionSearch?"#34D399":"#8899aa",fontSize:10,fontWeight:600,borderLeft:showSessionSearch?"2px solid #10B981":"2px solid transparent"}}>
            Search Sessions {showSessionSearch?"\u25B2":"\u25BC"}
          </button>
          {showSessionSearch&&(
            <div style={{padding:"6px 10px"}}>
              <input type="text" placeholder="Find session by name\u2026" value={sessionSearch} onChange={e=>setSessionSearch(e.target.value)}
                style={{width:"100%",padding:"5px 10px",borderRadius:5,border:"1px solid #3a4a5e",background:"rgba(0,0,0,0.3)",color:"#E2E8F0",fontSize:10,outline:"none",fontFamily:"'JetBrains Mono',monospace"}}/>
              {sessionResults.length>0&&(
                <div style={{maxHeight:200,overflowY:"auto",marginTop:4}}>
                  {sessionResults.map(p=>{
                    const chunk=chunkMap.get(p.chunk_id);
                    const isFocused=focusedSessionId===p.session_id;
                    return(<div key={p.session_id} onClick={()=>{setFocusedSessionId(p.session_id);setHighlighted(new Set([p.session_id]));}} style={{padding:"4px 6px",borderRadius:4,cursor:"pointer",background:isFocused?"rgba(16,185,129,0.12)":"transparent",border:isFocused?"1px solid rgba(16,185,129,0.3)":"1px solid transparent",marginBottom:2}}>
                      <div style={{fontSize:9,fontWeight:600,color:isFocused?"#34D399":"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'JetBrains Mono',monospace"}}>{p.name}</div>
                      <div style={{fontSize:8,color:"#5a6a7a"}}>Tier {p.tier} {chunk?"\u00B7 "+chunk.label:""}</div>
                    </div>);
                  })}
                </div>
              )}
              {focusedSessionId&&(
                <button onClick={()=>findLinked(focusedSessionId)} style={{width:"100%",marginTop:4,padding:"5px 8px",borderRadius:4,border:"1px solid rgba(245,158,11,0.4)",background:"rgba(245,158,11,0.08)",color:"#F59E0B",fontSize:9,fontWeight:600,cursor:"pointer"}}>Show Linked Sessions (shared tables)</button>
              )}
              {hasHighlight&&(
                <div style={{marginTop:4,padding:"4px 8px",borderRadius:4,background:"rgba(245,158,11,0.06)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:9,color:"#F59E0B"}}>{highlighted.size} sessions highlighted</span>
                  <button onClick={()=>{setFocusedSessionId(null);setHighlighted(new Set());}} style={{background:"transparent",border:"none",color:"#F59E0B",fontSize:9,cursor:"pointer",textDecoration:"underline"}}>Clear</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Select All / Deselect All */}
        <div style={{padding:"6px 10px",borderBottom:"1px solid #3a4a5e"}}>
          <button onClick={allSelected?handleDeselectAll:handleSelectAll} style={{width:"100%",padding:"5px 8px",borderRadius:4,border:"1px solid "+(hasFilter?"rgba(59,130,246,0.4)":"#3a4a5e"),background:hasFilter?"rgba(59,130,246,0.08)":"rgba(0,0,0,0.2)",color:hasFilter?"#60A5FA":"#8899aa",fontSize:10,fontWeight:600,cursor:"pointer"}}>
            {allSelected?"Deselect All":"Select All"}
            {hasFilter&&!allSelected&&<span style={{marginLeft:6,fontSize:9,opacity:0.7}}>({activeChunkIds.size} selected)</span>}
          </button>
        </div>

        {/* Chunk cards */}
        <div style={{flex:1,overflowY:"auto",padding:"6px 8px"}}>
          {filteredChunks.map(chunk=>{
            const isActive=activeChunkIds.has(chunk.id);
            const tierRange=chunk.tier_range||[1,1];
            const tierCount=tierRange[1]-tierRange[0]+1;
            return(<div key={chunk.id} onClick={()=>handleChunkToggle(chunk.id)} style={{padding:"10px 12px",marginBottom:4,borderRadius:8,cursor:"pointer",background:isActive?"rgba(59,130,246,0.1)":"rgba(0,0,0,0.2)",border:"1px solid "+(isActive?"#3B82F6":"#3a4a5e"),transition:"all 0.15s"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                {/* Checkbox */}
                <div style={{width:10,height:10,borderRadius:2,flexShrink:0,border:"1.5px solid "+(isActive?"#3B82F6":"#5a6a7a"),background:isActive?"#3B82F6":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {isActive&&<span style={{color:"#fff",fontSize:7,fontWeight:900,lineHeight:1}}>{"\u2713"}</span>}
                </div>
                <div style={{width:8,height:8,borderRadius:"50%",background:chunk.color,flexShrink:0}}/>
                <span style={{fontSize:10,fontWeight:700,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{chunk.label}</span>
                <span style={{fontSize:9,fontWeight:700,fontFamily:"monospace",padding:"1px 5px",borderRadius:4,background:"rgba(59,130,246,0.15)",color:"#60A5FA",flexShrink:0}}>{chunk.session_count}</span>
              </div>
              {/* Tier distribution bar */}
              {tierCount>0&&(
                <div style={{display:"flex",height:4,borderRadius:2,overflow:"hidden",marginBottom:3,background:"rgba(255,255,255,0.03)"}}>
                  {Array.from({length:tierCount},(_,i)=>(
                    <div key={i} style={{width:(100/tierCount)+"%",height:"100%",background:tierColorConst(tierRange[0]+i),minWidth:2}}/>
                  ))}
                </div>
              )}
              <div style={{fontSize:9,color:"#8899aa",marginBottom:3}}>Tier {tierRange[0]}\u2013{tierRange[1]}</div>
              {(chunk.pivot_tables||[]).length>0&&(
                <div style={{fontSize:8,color:"#5a6a7a",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{chunk.pivot_tables.slice(0,2).join(", ")}</div>
              )}
              {((chunk.conflict_count||0)>0||(chunk.chain_count||0)>0)&&(
                <div style={{display:"flex",gap:4,marginTop:4}}>
                  {(chunk.conflict_count||0)>0&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:"rgba(239,68,68,0.12)",color:"#FCA5A5"}}>{chunk.conflict_count} conflicts</span>}
                  {(chunk.chain_count||0)>0&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:"rgba(249,115,22,0.12)",color:"#FDBA74"}}>{chunk.chain_count} chains</span>}
                </div>
              )}
            </div>);
          })}
          {filteredChunks.length===0&&<div style={{padding:20,textAlign:"center",color:"#5a6a7a",fontSize:11}}>No clusters match</div>}
        </div>

        {/* Footer */}
        <div style={{padding:"6px 12px",borderTop:"1px solid #3a4a5e",fontSize:9,color:"#8899aa",textAlign:"center"}}>
          {hasFilter&&<span style={{color:"#60A5FA"}}>{activeChunkIds.size} selected \u00B7 </span>}
          {filteredChunks.length}/{constellationChunks.length} clusters \u00B7 {filteredChunks.reduce((a,c)=>a+c.session_count,0)} sessions
        </div>
      </div>

      {/* ── SVG canvas ── */}
      <div style={{flex:1,position:"relative",background:"#1a2332"}}>
        <svg ref={svgRef} width="100%" height="100%" onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} style={{cursor:dragRef.current?"grabbing":"grab"}}>
          <g transform={"translate("+transform.x+","+transform.y+") scale("+transform.k+")"}>
            {/* Hulls */}
            {showHulls&&hulls.map(h=>{
              const isSelected=!hasFilter||activeChunkIds.has(h.id);
              return(<polygon key={h.id} points={h.hull.map(p=>sx(p.x)+","+sy(p.y)).join(" ")} fill={h.color} fillOpacity={isSelected?0.08:0.02} stroke={h.color} strokeOpacity={isSelected?0.3:0.05} strokeWidth={activeChunkIds.has(h.id)?2:1} onClick={()=>handleChunkToggle(h.id)} style={{cursor:"pointer"}}/>);
            })}
            {/* Cross-chunk edges */}
            {showEdges&&crossChunkEdges.map((e,i)=>{
              if(hasFilter&&!activeChunkIds.has(e.from_chunk)&&!activeChunkIds.has(e.to_chunk))return null;
              const fc=constellationPoints.filter(p=>p.chunk_id===e.from_chunk);
              const tc=constellationPoints.filter(p=>p.chunk_id===e.to_chunk);
              if(!fc.length||!tc.length)return null;
              const fx=fc.reduce((a,p)=>a+p.x,0)/fc.length;
              const fy=fc.reduce((a,p)=>a+p.y,0)/fc.length;
              const tx2=tc.reduce((a,p)=>a+p.x,0)/tc.length;
              const ty=tc.reduce((a,p)=>a+p.y,0)/tc.length;
              const mx=(sx(fx)+sx(tx2))/2;const my=(sy(fy)+sy(ty))/2;
              const dx=sx(tx2)-sx(fx);const dy=sy(ty)-sy(fy);
              return(<path key={i} d={"M"+sx(fx)+","+sy(fy)+" Q"+(mx-dy*0.15)+","+(my+dx*0.15)+" "+sx(tx2)+","+sy(ty)} fill="none" stroke={"rgba(148,163,184,"+Math.min(0.4,e.count*0.05)+")"} strokeWidth={Math.min(Math.sqrt(e.count)*0.5,4)}/>);
            })}
            {/* Session dots */}
            {constellationPoints.map(p=>{
              const color=chunkColorMap.get(p.chunk_id)||"#3B82F6";
              const isInCluster=!hasFilter||activeChunkIds.has(p.chunk_id);
              const isHi=hasHighlight?highlighted.has(p.session_id):null;
              if(isHi===false)return(<circle key={p.session_id} cx={sx(p.x)} cy={sy(p.y)} r={1.5} fill="rgba(100,116,139,0.08)"/>);
              return(<g key={p.session_id}>
                {isHi===true&&<circle cx={sx(p.x)} cy={sy(p.y)} r={6} fill="none" stroke="rgba(245,158,11,0.8)" strokeWidth={2}/>}
                <circle cx={sx(p.x)} cy={sy(p.y)} r={2.5} fill={color} opacity={isInCluster?0.7:0.08}
                  onMouseEnter={()=>setHov(p)} onMouseLeave={()=>setHov(null)} onClick={()=>handleChunkToggle(p.chunk_id)} style={{cursor:"pointer"}}/>
                {p.critical&&isInCluster&&<circle cx={sx(p.x)} cy={sy(p.y)} r={6} fill="none" stroke="rgba(239,68,68,0.5)" strokeWidth={1}/>}
              </g>);
            })}
            {/* Cluster labels at centroids */}
            {Array.from(centroids.entries()).map(([id,c])=>{
              const chunk=chunkMap.get(id);
              if(!chunk)return null;
              const isVisible=!hasFilter||activeChunkIds.has(id);
              if(!isVisible)return null;
              return(<g key={"lbl-"+id}>
                <rect x={sx(c.x)-40} y={sy(c.y)-8} width={80} height={16} rx={4} fill="rgba(0,0,0,0.7)" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5}/>
                <text x={sx(c.x)} y={sy(c.y)+3} textAnchor="middle" fill="#E2E8F0" fontSize={8} fontFamily="'JetBrains Mono',monospace" fontWeight={600} style={{pointerEvents:"none"}}>{chunk.label.length>14?chunk.label.slice(0,14)+"\u2026":chunk.label}</text>
              </g>);
            })}
          </g>
        </svg>

        {/* Zoom buttons */}
        <div style={{position:"absolute",right:240,top:"50%",transform:"translateY(-50%)",display:"flex",flexDirection:"column",gap:4}}>
          {[{label:"+",factor:1.5},{label:"-",factor:0.67}].map(b=>(
            <button key={b.label} onClick={()=>{
              const svg=svgRef.current;if(!svg)return;
              const rect=svg.getBoundingClientRect();
              const cx=rect.width/2;const cy=rect.height/2;
              setTransform(prev=>{const nk=Math.max(0.3,Math.min(20,prev.k*b.factor));return{x:cx-(cx-prev.x)*nk/prev.k,y:cy-(cy-prev.y)*nk/prev.k,k:nk};});
            }} style={{width:28,height:28,borderRadius:5,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(26,35,50,0.85)",color:"#94A3B8",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{b.label}</button>
          ))}
        </div>

        {/* Tooltip */}
        {hov&&(
          <div style={{position:"absolute",top:10,left:10,padding:"6px 12px",borderRadius:6,background:"rgba(26,35,50,0.92)",border:"1px solid rgba(148,163,184,0.3)",fontSize:10,color:"#E2E8F0",pointerEvents:"none",fontFamily:"'JetBrains Mono',monospace"}}>
            <div style={{fontWeight:700}}>{hov.name}</div>
            <div style={{color:"#94A3B8"}}>Tier {hov.tier}{hov.critical?" (critical)":""} \u00B7 {chunkMap.get(hov.chunk_id)?.label||""}</div>
          </div>
        )}

        {/* Minimap */}
        <div style={{position:"absolute",bottom:40,left:10,width:160,height:120,background:"rgba(26,35,50,0.85)",border:"1px solid rgba(30,41,59,0.6)",borderRadius:6,overflow:"hidden"}}>
          <svg width={160} height={120} style={{display:"block"}}>
            {constellationPoints.map(p=>{
              const color=chunkColorMap.get(p.chunk_id)||"#3B82F6";
              return(<circle key={p.session_id} cx={10+p.x*140} cy={5+p.y*110} r={0.8} fill={color} opacity={0.6}/>);
            })}
          </svg>
        </div>

        {/* Stats bar */}
        <div style={{position:"absolute",bottom:12,left:180,padding:"6px 14px",borderRadius:8,background:"rgba(26,35,50,0.85)",border:"1px solid rgba(30,41,59,0.6)",display:"flex",gap:16,fontSize:10,color:"#8899aa"}}>
          <span><strong style={{color:"#E2E8F0"}}>{constellationPoints.length.toLocaleString()}</strong> Sessions</span>
          <span><strong style={{color:"#3B82F6"}}>{constellationChunks.length}</strong> Clusters</span>
          {criticalCount>0&&<span><strong style={{color:"#EF4444"}}>{criticalCount}</strong> Critical</span>}
          <span style={{color:"#5a6a7a"}}>Scroll/drag \u00B7 Shift+click=path</span>
        </div>
      </div>

      {/* ── Right sidebar: algorithm list + display controls ── */}
      <div style={{width:220,flexShrink:0,borderLeft:"1px solid rgba(30,41,59,0.6)",background:"rgba(26,35,50,0.6)",overflowY:"auto",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"12px 14px",borderBottom:"1px solid rgba(30,41,59,0.6)"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#10B981",textTransform:"uppercase",letterSpacing:"0.1em"}}>Clustering Algorithm</div>
        </div>
        <div style={{padding:"8px 10px",flex:1}}>
          {ALGO_KEYS_CONST.map(key=>{
            const meta=ALGO_META_CONST[key];
            const isActive=key===activeAlgo;
            return(<div key={key} style={{padding:"10px 12px",marginBottom:6,borderRadius:8,background:isActive?"rgba(16,185,129,0.1)":"rgba(0,0,0,0.2)",border:"1px solid "+(isActive?"#10B981":"rgba(30,41,59,0.4)"),opacity:isActive?1:0.8}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <span style={{fontSize:14,lineHeight:1,color:isActive?"#34D399":"#8899aa"}}>{meta.icon}</span>
                <span style={{fontSize:11,fontWeight:700,color:isActive?"#34D399":"#CBD5E1"}}>{meta.name}</span>
                {isActive&&<span style={{marginLeft:"auto",fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"rgba(16,185,129,0.2)",color:"#34D399"}}>ACTIVE</span>}
              </div>
              <div style={{fontSize:9,color:isActive?"rgba(52,211,153,0.7)":"#5a6a7a",lineHeight:1.4}}>{meta.desc}</div>
            </div>);
          })}
        </div>

        {/* Display section */}
        <div style={{padding:"12px 14px",borderTop:"1px solid rgba(30,41,59,0.6)"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#10B981",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Display</div>
          {[{label:"Connection Lines",value:showEdges,setter:setShowEdges},{label:"Cluster Shading",value:showHulls,setter:setShowHulls}].map(({label,value,setter})=>(
            <div key={label} style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:10,color:"#CBD5E1"}}>{label}</span>
              <div onClick={()=>setter(v=>!v)} style={{width:28,height:16,borderRadius:8,cursor:"pointer",background:value?"#10B981":"#4a5a6e",position:"relative",transition:"background 0.15s"}}>
                <div style={{width:12,height:12,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:value?14:2,transition:"left 0.15s"}}/>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// DRILL-THROUGH FILTER ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const BUCKET_COLORS={Simple:"#22C55E",Medium:"#EAB308",Complex:"#F97316","Very Complex":"#EF4444"};
const BUCKET_ORDER=["Simple","Medium","Complex","Very Complex"];

function computeDrillFilterIds(filter, vr) {
  if (!vr || Object.keys(filter).length === 0) return null;
  const sets = [];
  if (filter.complexity_bucket) {
    const s = new Set();
    for (const score of (vr.v11_complexity?.scores ?? [])) {
      if (score.bucket === filter.complexity_bucket) s.add(score.session_id);
    }
    sets.push(s);
  }
  if (filter.wave_number?.length) {
    const waveSet = new Set(filter.wave_number);
    const s = new Set();
    for (const wave of (vr.v4_wave_plan?.waves ?? [])) {
      if (waveSet.has(wave.wave_number)) wave.session_ids.forEach(id => s.add(id));
    }
    sets.push(s);
  }
  if (filter.criticality_tier_min != null) {
    const s = new Set();
    for (const sc of (vr.v9_wave_function?.sessions ?? [])) {
      if ((sc.criticality_tier ?? 0) >= filter.criticality_tier_min) s.add(sc.session_id);
    }
    sets.push(s);
  }
  if (filter.community_macro != null) {
    const macros = vr.v1_communities?.macro_communities ?? {};
    const sids = macros[String(filter.community_macro)] ?? [];
    sets.push(new Set(sids));
  }
  if (filter.is_independent) {
    const s = new Set();
    for (const si of (vr.v10_concentration?.independent_sessions ?? [])) s.add(si.session_id);
    sets.push(s);
  }
  if (sets.length === 0) return null;
  let result = sets[0];
  for (let i = 1; i < sets.length; i++) {
    result = new Set([...result].filter(x => sets[i].has(x)));
  }
  return result;
}

const DrillThroughPanel = ({filter, onFilterChange, matchingCount}) => {
  const [expanded, setExpanded] = useState({complexity:true,wave:false,criticality:false,community:false,independence:false});
  const toggle = (k) => setExpanded(p=>({...p,[k]:!p[k]}));
  const activeCount = Object.keys(filter).filter(k=>{const v=filter[k];return v!=null&&v!==false&&!(Array.isArray(v)&&v.length===0);}).length;
  const clearAll = () => onFilterChange({});

  const bucketCounts = useMemo(()=>{
    const c={Simple:0,Medium:0,Complex:0,"Very Complex":0};
    (vectorResults?.v11_complexity?.scores??[]).forEach(s=>{if(c[s.bucket]!=null)c[s.bucket]++;});
    return c;
  },[]);

  const waveNums = useMemo(()=>(vectorResults?.v4_wave_plan?.waves??[]).map(w=>w.wave_number).sort((a,b)=>a-b),[]);
  const macroKeys = useMemo(()=>Object.keys(vectorResults?.v1_communities?.macro_communities??{}).map(Number).sort((a,b)=>a-b),[]);

  const Section = ({id,label,children}) => (
    <div style={{borderBottom:"1px solid #3a4a5e"}}>
      <div onClick={()=>toggle(id)} style={{padding:"8px 12px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.05em"}}>
        {label}<span style={{fontSize:9,transition:"transform 0.15s",display:"inline-block",transform:expanded[id]?"rotate(90deg)":"rotate(0deg)"}}>▶</span>
      </div>
      {expanded[id]&&<div style={{padding:"4px 12px 10px"}}>{children}</div>}
    </div>
  );

  const FilterBtn = ({active,onClick,label,count,color}) => (
    <button onClick={onClick} style={{padding:"4px 10px",borderRadius:5,border:"1px solid "+(active?"rgba(59,130,246,0.5)":"#3a4a5e"),background:active?"rgba(59,130,246,0.15)":"transparent",color:active?"#60A5FA":"#94A3B8",fontSize:10,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
      {color&&<span style={{width:6,height:6,borderRadius:"50%",background:color,display:"inline-block"}}/>}{label}{count!=null&&<span style={{fontSize:8,color:"#5a6a7a",marginLeft:2}}>{count}</span>}
    </button>
  );

  return (
    <div style={{width:"100%",height:"100%",overflowY:"auto",background:"rgba(26,35,50,0.6)"}}>
      <div style={{padding:"10px 12px",borderBottom:"1px solid #3a4a5e",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#E2E8F0"}}>Drill-Through Filters</div>
        {activeCount>0&&<button onClick={clearAll} style={{fontSize:9,padding:"2px 8px",borderRadius:4,border:"1px solid rgba(239,68,68,0.4)",background:"transparent",color:"#EF4444",cursor:"pointer"}}>Clear All</button>}
      </div>
      {matchingCount!=null&&<div style={{padding:"6px 12px",borderBottom:"1px solid #3a4a5e",fontSize:10,color:"#60A5FA"}}>{matchingCount} matching sessions</div>}
      {hasComplexity&&<Section id="complexity" label="Complexity">
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {BUCKET_ORDER.map(b=>(<FilterBtn key={b} active={filter.complexity_bucket===b} color={BUCKET_COLORS[b]} label={b} count={bucketCounts[b]} onClick={()=>onFilterChange({...filter,complexity_bucket:filter.complexity_bucket===b?undefined:b})}/>))}
        </div>
      </Section>}
      {hasWavePlan&&<Section id="wave" label="Wave">
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {waveNums.map(w=>{const active=(filter.wave_number||[]).includes(w);return(<FilterBtn key={w} active={active} label={"W"+w} onClick={()=>{const cur=filter.wave_number||[];const next=active?cur.filter(x=>x!==w):[...cur,w];onFilterChange({...filter,wave_number:next.length?next:undefined});}}/>);})}
        </div>
      </Section>}
      {vectorResults?.v9_wave_function&&<Section id="criticality" label="Criticality">
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {[1,2,3,4,5].map(t=>(<FilterBtn key={t} active={filter.criticality_tier_min===t} label={"Tier "+t+"+"} onClick={()=>onFilterChange({...filter,criticality_tier_min:filter.criticality_tier_min===t?undefined:t})}/>))}
        </div>
      </Section>}
      {vectorResults?.v1_communities&&<Section id="community" label="Community">
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {macroKeys.map(k=>(<FilterBtn key={k} active={filter.community_macro===k} label={"C"+k} onClick={()=>onFilterChange({...filter,community_macro:filter.community_macro===k?undefined:k})}/>))}
        </div>
      </Section>}
      {hasConcentration&&<Section id="independence" label="Independence">
        <FilterBtn active={!!filter.is_independent} label="Independent Only" count={(vectorResults?.v10_concentration?.independent_sessions??[]).length} onClick={()=>onFilterChange({...filter,is_independent:filter.is_independent?undefined:true})}/>
      </Section>}
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// NO DATA MESSAGE
// ═══════════════════════════════════════════════════════════════════════════════

const NoDataMessage = ({label}) => (
  <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",opacity:0.5}}>
    <div style={{fontSize:28,marginBottom:12}}>—</div>
    <div style={{fontSize:13,color:C.textMuted,textAlign:"center",maxWidth:340}}>{label || "Run vector analysis in the main app to include this data in exports."}</div>
  </div>
);


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: COMPLEXITY
// ═══════════════════════════════════════════════════════════════════════════════

const ComplexityView = ({filterIds}) => {
  const [selId,setSelId] = useState(null);
  const [sortBy,setSortBy] = useState("score");
  const cx = vectorResults?.v11_complexity;
  if(!cx) return <NoDataMessage/>;

  const scores = useMemo(()=>{
    let s=cx.scores||[];
    if(filterIds) s=s.filter(sc=>filterIds.has(sc.session_id));
    return sortBy==="score"?[...s].sort((a,b)=>b.overall_score-a.overall_score):[...s].sort((a,b)=>a.name.localeCompare(b.name));
  },[filterIds,sortBy]);

  const dist = useMemo(()=>{const d={Simple:0,Medium:0,Complex:0,"Very Complex":0};scores.forEach(s=>{if(d[s.bucket]!=null)d[s.bucket]++;});return d;},[scores]);
  const total=scores.length||1;
  const sel=selId?scores.find(s=>s.session_id===selId):null;
  const stats=cx.aggregate_stats||{};

  return (
    <div style={{height:"100%",overflowY:"auto"}}>
      <div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
        {[["Mean",stats.mean?.toFixed(1)],["Median",stats.median?.toFixed(1)],["Std Dev",stats.std_dev?.toFixed(1)],["Est. Hours",cx.total_hours_low+"–"+cx.total_hours_high]].map(([l,v])=>(
          <div key={l} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:8,padding:"10px 16px",minWidth:100,textAlign:"center"}}>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>{v}</div><div style={{fontSize:9,color:C.textDim,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",height:28,borderRadius:6,overflow:"hidden",marginBottom:16}}>
        {BUCKET_ORDER.map(b=>dist[b]>0?<div key={b} style={{width:(dist[b]/total*100)+"%",background:BUCKET_COLORS[b],display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:"#fff",minWidth:dist[b]>0?30:0}} title={b+": "+dist[b]}>{dist[b]}</div>:null)}
      </div>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <button onClick={()=>setSortBy("score")} style={{fontSize:10,padding:"3px 10px",borderRadius:4,border:"1px solid "+(sortBy==="score"?"#3B82F6":"#3a4a5e"),background:sortBy==="score"?"rgba(59,130,246,0.15)":"transparent",color:sortBy==="score"?"#60A5FA":"#8899aa",cursor:"pointer"}}>By Score</button>
        <button onClick={()=>setSortBy("name")} style={{fontSize:10,padding:"3px 10px",borderRadius:4,border:"1px solid "+(sortBy==="name"?"#3B82F6":"#3a4a5e"),background:sortBy==="name"?"rgba(59,130,246,0.15)":"transparent",color:sortBy==="name"?"#60A5FA":"#8899aa",cursor:"pointer"}}>By Name</button>
      </div>
      <div style={{display:"flex",gap:16}}>
        <div style={{width:340,flexShrink:0,overflowY:"auto",maxHeight:500}}>
          {scores.map(s=>(
            <div key={s.session_id} onClick={()=>setSelId(p=>p===s.session_id?null:s.session_id)} style={{padding:"8px 12px",marginBottom:3,borderRadius:6,cursor:"pointer",background:selId===s.session_id?"rgba(59,130,246,0.12)":C.surface,border:"1px solid "+(selId===s.session_id?C.borderActive:C.border),display:"flex",alignItems:"center",gap:8}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:BUCKET_COLORS[s.bucket],flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}><div style={{fontSize:10,fontWeight:600,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div></div>
              <div style={{fontSize:10,fontWeight:700,color:BUCKET_COLORS[s.bucket],flexShrink:0}}>{s.overall_score.toFixed(1)}</div>
            </div>
          ))}
        </div>
        {sel&&<div style={{flex:1}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>{sel.name}</div>
          <div style={{fontSize:10,color:C.textDim,marginBottom:12}}>Score: {sel.overall_score.toFixed(2)} ({sel.bucket}) · Est: {sel.hours_estimate_low}–{sel.hours_estimate_high}h</div>
          {(sel.dimensions||[]).map(d=>(
            <div key={d.name} style={{marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.textMuted,marginBottom:2}}><span>{d.name}</span><span>{(d.normalized*100).toFixed(0)}%</span></div>
              <div style={{height:6,borderRadius:3,background:"#3a4a5e",overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:d.normalized>0.7?"#EF4444":d.normalized>0.4?"#F59E0B":"#22C55E",width:(d.normalized*100)+"%"}}/></div>
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: WAVE PLAN
// ═══════════════════════════════════════════════════════════════════════════════

const WAVE_COLORS=["#3B82F6","#EAB308","#A855F7","#10B981","#F97316","#06B6D4","#EC4899","#84CC16","#F43F5E","#8B5CF6"];

const WavePlanView = ({filterIds}) => {
  const [expanded,setExpanded] = useState({});
  const wp = vectorResults?.v4_wave_plan;
  if(!wp) return <NoDataMessage/>;
  const waves = wp.waves||[];
  const maxSessions = Math.max(...waves.map(w=>w.session_count),1);
  const sccMap = useMemo(()=>{const m=new Map();(wp.scc_groups||[]).forEach(g=>m.set(g.group_id,g));return m;},[]);

  return (
    <div style={{height:"100%",overflowY:"auto"}}>
      <div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
        {[["Total Waves",waves.length],["Critical Path",wp.critical_path_length],["Cyclic",wp.cyclic_session_count],["Acyclic",wp.acyclic_session_count],["SCC Groups",(wp.scc_groups||[]).length]].map(([l,v])=>(
          <div key={l} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:8,padding:"10px 16px",minWidth:90,textAlign:"center"}}>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>{v}</div><div style={{fontSize:9,color:C.textDim,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
      {waves.map(w=>{
        const color=WAVE_COLORS[(w.wave_number-1)%WAVE_COLORS.length];
        const hasScc=w.scc_groups?.length>0;
        const isExp=expanded[w.wave_number];
        const sids=filterIds?w.session_ids.filter(id=>filterIds.has(id)):w.session_ids;
        return(
          <div key={w.wave_number} style={{marginBottom:8,background:C.surface,border:"1px solid "+(hasScc?"rgba(245,158,11,0.4)":C.border),borderRadius:8,padding:"12px 16px"}}>
            <div onClick={()=>setExpanded(p=>({...p,[w.wave_number]:!p[w.wave_number]}))} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800,color:"#fff",flexShrink:0}}>W{w.wave_number}</div>
              <div style={{flex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:C.text}}>Wave {w.wave_number}</span>
                  <span style={{fontSize:10,color:C.textDim}}>{sids.length} sessions</span>
                  {hasScc&&<span style={{fontSize:8,padding:"2px 6px",borderRadius:4,background:"rgba(245,158,11,0.1)",color:"#F59E0B",fontWeight:700}}>SCC</span>}
                  {w.prerequisite_waves?.length>0&&<span style={{fontSize:9,color:C.textDim}}>After: {w.prerequisite_waves.map(p=>"W"+p).join(", ")}</span>}
                </div>
                <div style={{height:6,borderRadius:3,background:"#3a4a5e",marginTop:6,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:color,width:(w.session_count/maxSessions*100)+"%"}}/></div>
              </div>
              <span style={{fontSize:10,color:C.textDim}}>{isExp?"▼":"▶"}</span>
            </div>
            {isExp&&<div style={{marginTop:10,display:"flex",gap:4,flexWrap:"wrap"}}>
              {sids.map(id=>{const sd=sessionData[id];return(<span key={id} style={{fontSize:9,padding:"3px 8px",borderRadius:4,background:"rgba(255,255,255,0.04)",border:"1px solid "+C.border,color:C.text,fontFamily:"monospace"}}>{sd?.short||id}</span>);})}
            </div>}
          </div>
        );
      })}
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: CONCENTRATION / GRAVITY
// ═══════════════════════════════════════════════════════════════════════════════

const GRP_COLORS=["#3B82F6","#EAB308","#A855F7","#10B981","#F97316","#06B6D4","#EC4899","#84CC16","#F43F5E","#8B5CF6","#14B8A6","#FB923C"];

const ConcentrationView = ({filterIds}) => {
  const [selGroup,setSelGroup] = useState(null);
  const [showIndep,setShowIndep] = useState(false);
  const conc = vectorResults?.v10_concentration;
  if(!conc) return <NoDataMessage/>;
  const groups=conc.gravity_groups||[];
  const indep=conc.independent_sessions||[];

  return (
    <div style={{height:"100%",overflowY:"auto"}}>
      <div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
        {[["Groups",groups.length],["Independent",indep.length],["Optimal K",conc.optimal_k],["Silhouette",conc.silhouette?.toFixed(3)]].map(([l,v])=>(
          <div key={l} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:8,padding:"10px 16px",minWidth:90,textAlign:"center"}}>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>{v}</div><div style={{fontSize:9,color:C.textDim,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:16}}>
        <div style={{width:280,flexShrink:0,overflowY:"auto",maxHeight:500}}>
          {groups.map((g,i)=>{
            const color=GRP_COLORS[i%GRP_COLORS.length];
            const sids=filterIds?g.session_ids.filter(id=>filterIds.has(id)):g.session_ids;
            return(
              <div key={g.group_id} onClick={()=>{setSelGroup(p=>p===g.group_id?null:g.group_id);setShowIndep(false);}} style={{padding:"10px 12px",marginBottom:4,borderRadius:6,cursor:"pointer",background:selGroup===g.group_id?"rgba(59,130,246,0.12)":C.surface,border:"1px solid "+(selGroup===g.group_id?C.borderActive:C.border)}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:color,flexShrink:0}}/>
                  <span style={{fontSize:11,fontWeight:600,color:C.text}}>Group {g.group_id}</span>
                  <span style={{fontSize:9,color:C.textDim,marginLeft:"auto"}}>{sids.length} sessions</span>
                </div>
                <div style={{display:"flex",gap:8,marginTop:4,fontSize:9,color:C.textDim}}>
                  <span>Cohesion: {g.cohesion?.toFixed(2)}</span><span>Coupling: {g.coupling?.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
          {indep.length>0&&<div onClick={()=>{setShowIndep(p=>!p);setSelGroup(null);}} style={{padding:"10px 12px",marginTop:8,borderRadius:6,cursor:"pointer",background:showIndep?"rgba(245,158,11,0.12)":C.surface,border:"1px solid "+(showIndep?"#F59E0B":C.border)}}>
            <div style={{fontSize:11,fontWeight:600,color:"#F59E0B"}}>Independent Sessions ({indep.length})</div>
          </div>}
        </div>
        <div style={{flex:1}}>
          {selGroup!=null&&(()=>{const g=groups.find(x=>x.group_id===selGroup);if(!g)return null;return(
            <div>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>Group {g.group_id}</div>
              <div style={{fontSize:10,color:C.textDim,marginBottom:8}}>Medoid: {sessionData[g.medoid_session_id]?.short||g.medoid_session_id}</div>
              {g.core_tables?.length>0&&<div style={{marginBottom:10}}>
                <div style={{fontSize:9,fontWeight:700,color:C.textMuted,marginBottom:4}}>CORE TABLES</div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{g.core_tables.map(t=>(<span key={t} style={{fontSize:9,padding:"2px 8px",borderRadius:4,background:"rgba(59,130,246,0.08)",color:"#60A5FA",fontFamily:"monospace"}}>{t}</span>))}</div>
              </div>}
              <div style={{fontSize:9,fontWeight:700,color:C.textMuted,marginBottom:4}}>SESSIONS ({g.session_ids.length})</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{g.session_ids.map(id=>(<span key={id} style={{fontSize:9,padding:"3px 8px",borderRadius:4,background:"rgba(255,255,255,0.04)",border:"1px solid "+C.border,color:C.text,fontFamily:"monospace"}}>{sessionData[id]?.short||id}</span>))}</div>
            </div>
          );})()}
          {showIndep&&<div>
            <div style={{fontSize:13,fontWeight:700,color:"#F59E0B",marginBottom:8}}>Independent Sessions</div>
            {indep.map(s=>(
              <div key={s.session_id} style={{padding:"8px 12px",marginBottom:4,borderRadius:6,background:C.surface,border:"1px solid "+C.border}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:10,fontWeight:600,color:C.text}}>{sessionData[s.session_id]?.short||s.session_id}</span>
                  <span style={{fontSize:8,padding:"1px 6px",borderRadius:3,background:s.independence_type==="full"?"rgba(59,130,246,0.1)":"rgba(245,158,11,0.1)",color:s.independence_type==="full"?"#60A5FA":"#F59E0B"}}>{s.independence_type}</span>
                  <span style={{fontSize:9,color:C.textDim,marginLeft:"auto"}}>{(s.confidence*100).toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>}
          {selGroup==null&&!showIndep&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",opacity:0.4}}><div style={{fontSize:12,color:C.textMuted}}>Select a group to inspect</div></div>}
        </div>
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: CONSENSUS RADAR
// ═══════════════════════════════════════════════════════════════════════════════

const ConsensusRadarView = ({filterIds}) => {
  const [selId,setSelId] = useState(null);
  const [sortBy,setSortBy] = useState("score");
  const ens = vectorResults?.v8_ensemble_consensus;
  if(!ens) return <NoDataMessage/>;

  const sessions = useMemo(()=>{
    let s=ens.sessions||[];
    if(filterIds) s=s.filter(x=>filterIds.has(x.session_id));
    return sortBy==="score"?[...s].sort((a,b)=>b.consensus_score-a.consensus_score):[...s].sort((a,b)=>(b.is_contested?1:0)-(a.is_contested?1:0));
  },[filterIds,sortBy]);

  const sel=selId?sessions.find(s=>s.session_id===selId):null;

  return (
    <div style={{height:"100%",overflowY:"auto"}}>
      <div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
        {[["Clusters",ens.n_clusters],["Contested",ens.contested_count],["High Confidence",ens.high_confidence_count],["Vectors",ens.vectors_used?.length||0]].map(([l,v])=>(
          <div key={l} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:8,padding:"10px 16px",minWidth:90,textAlign:"center"}}>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>{v}</div><div style={{fontSize:9,color:C.textDim,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <button onClick={()=>setSortBy("score")} style={{fontSize:10,padding:"3px 10px",borderRadius:4,border:"1px solid "+(sortBy==="score"?"#3B82F6":"#3a4a5e"),background:sortBy==="score"?"rgba(59,130,246,0.15)":"transparent",color:sortBy==="score"?"#60A5FA":"#8899aa",cursor:"pointer"}}>By Score</button>
        <button onClick={()=>setSortBy("contested")} style={{fontSize:10,padding:"3px 10px",borderRadius:4,border:"1px solid "+(sortBy==="contested"?"#3B82F6":"#3a4a5e"),background:sortBy==="contested"?"rgba(59,130,246,0.15)":"transparent",color:sortBy==="contested"?"#60A5FA":"#8899aa",cursor:"pointer"}}>By Contested</button>
      </div>
      <div style={{display:"flex",gap:16}}>
        <div style={{width:300,flexShrink:0,overflowY:"auto",maxHeight:500}}>
          {sessions.map(s=>(
            <div key={s.session_id} onClick={()=>setSelId(p=>p===s.session_id?null:s.session_id)} style={{padding:"8px 12px",marginBottom:3,borderRadius:6,cursor:"pointer",background:selId===s.session_id?"rgba(59,130,246,0.12)":C.surface,border:"1px solid "+(selId===s.session_id?C.borderActive:C.border),display:"flex",alignItems:"center",gap:8}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:s.is_contested?"#EF4444":s.consensus_score>0.8?"#22C55E":"#F59E0B",flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}><div style={{fontSize:10,fontWeight:600,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sessionData[s.session_id]?.short||s.session_id}</div></div>
              <div style={{fontSize:10,fontWeight:700,color:s.is_contested?"#EF4444":s.consensus_score>0.8?"#22C55E":"#F59E0B",flexShrink:0}}>{(s.consensus_score*100).toFixed(0)}%</div>
            </div>
          ))}
        </div>
        {sel?<div style={{flex:1}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>{sessionData[sel.session_id]?.short||sel.session_id}</div>
          <div style={{fontSize:10,color:C.textDim,marginBottom:12}}>Consensus: {(sel.consensus_score*100).toFixed(1)}% · Cluster {sel.consensus_cluster}{sel.is_contested?" (contested)":""}</div>
          <div style={{fontSize:9,fontWeight:700,color:C.textMuted,marginBottom:6}}>PER-VECTOR ASSIGNMENTS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
            {Object.entries(sel.per_vector_assignments||{}).map(([vec,cluster])=>{
              const match=cluster===sel.consensus_cluster;
              return(<div key={vec} style={{padding:"6px 10px",borderRadius:5,background:match?"rgba(34,197,94,0.08)":"rgba(239,68,68,0.08)",border:"1px solid "+(match?"rgba(34,197,94,0.3)":"rgba(239,68,68,0.3)"),display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:9,color:C.textMuted}}>{vec}</span>
                <span style={{fontSize:10,fontWeight:700,color:match?"#22C55E":"#EF4444"}}>{match?"✓":"✗"} C{cluster}</span>
              </div>);
            })}
          </div>
        </div>:<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",opacity:0.4}}><div style={{fontSize:12,color:C.textMuted}}>Select a session to inspect</div></div>}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: HEAT MAP (Canvas)
// ═══════════════════════════════════════════════════════════════════════════════

const HeatMapView = ({filterIds}) => {
  const canvasRef = useRef(null);
  const cx = vectorResults?.v11_complexity;
  if(!cx) return <NoDataMessage/>;

  const scores = useMemo(()=>{
    let s=cx.scores||[];
    if(filterIds) s=s.filter(sc=>filterIds.has(sc.session_id));
    return s;
  },[filterIds]);

  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas)return;
    const ctx=canvas.getContext("2d");
    const dpr=window.devicePixelRatio||1;
    const tiers=[...new Set(scores.map(s=>{const ts=tierSessions.find(t=>t.id===s.session_id||t.full===s.session_id);return ts?ts.tier:1;}))].sort((a,b)=>a-b);
    if(tiers.length===0)tiers.push(1);
    const buckets=BUCKET_ORDER;
    const LW=80,CW=80,CH=50,PAD=10;
    const w=LW+tiers.length*CW+PAD;
    const h=40+buckets.length*CH+PAD+30;
    canvas.width=w*dpr;canvas.height=h*dpr;
    canvas.style.width=w+"px";canvas.style.height=h+"px";
    ctx.scale(dpr,dpr);
    ctx.fillStyle=C.bg;ctx.fillRect(0,0,w,h);

    // Count grid
    const grid={};let maxCount=1;
    scores.forEach(s=>{
      const ts=tierSessions.find(t=>t.id===s.session_id||t.full===s.session_id);
      const tier=ts?ts.tier:1;
      const key=tier+"|"+s.bucket;
      grid[key]=(grid[key]||0)+1;
      if(grid[key]>maxCount)maxCount=grid[key];
    });

    // Headers
    ctx.font="11px Inter,sans-serif";ctx.fillStyle="#8899aa";ctx.textAlign="center";
    tiers.forEach((t,i)=>{ctx.fillText("T"+t,LW+i*CW+CW/2,28);});
    ctx.textAlign="right";
    buckets.forEach((b,i)=>{ctx.fillStyle=BUCKET_COLORS[b];ctx.fillText(b,LW-8,44+i*CH+CH/2+4);});

    // Cells
    const CELL_COLORS={Simple:[34,197,94],Medium:[234,179,8],Complex:[249,115,22],"Very Complex":[239,68,68]};
    tiers.forEach((t,ti)=>{
      buckets.forEach((b,bi)=>{
        const count=grid[t+"|"+b]||0;
        const x=LW+ti*CW+2,y=36+bi*CH+2,cw=CW-4,ch=CH-4;
        if(count>0){
          const intensity=Math.max(count/maxCount,0.15);
          const rgb=CELL_COLORS[b]||[59,130,246];
          ctx.fillStyle="rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+","+intensity+")";
          ctx.beginPath();ctx.roundRect(x,y,cw,ch,4);ctx.fill();
          ctx.fillStyle=intensity>0.5?"#fff":"#94A3B8";ctx.font="bold 14px Inter,sans-serif";ctx.textAlign="center";
          ctx.fillText(String(count),x+cw/2,y+ch/2+5);
        } else {
          ctx.fillStyle="rgba(30,41,59,0.3)";ctx.beginPath();ctx.roundRect(x,y,cw,ch,4);ctx.fill();
        }
      });
    });

    // Legend
    const ly=36+buckets.length*CH+12;
    ctx.font="10px Inter,sans-serif";ctx.textAlign="left";
    let lx=LW;
    buckets.forEach(b=>{
      ctx.fillStyle=BUCKET_COLORS[b];ctx.beginPath();ctx.roundRect(lx,ly,10,10,2);ctx.fill();
      ctx.fillStyle="#94A3B8";ctx.fillText(b,lx+14,ly+9);
      lx+=ctx.measureText(b).width+28;
    });
  },[scores]);

  return <div style={{height:"100%",overflow:"auto",display:"flex",alignItems:"flex-start",justifyContent:"center",padding:20}}><canvas ref={canvasRef}/></div>;
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: TABLE EXPLORER
// ═══════════════════════════════════════════════════════════════════════════════

const TableExplorerView = ({filterIds}) => {
  const [selTable,setSelTable] = useState(null);
  const [search,setSearch] = useState("");

  const tableList = useMemo(()=>{
    const tables=Object.entries(allTables).map(([name,info])=>{
      const total=info.writes.length+info.reads.length+info.lookups.length;
      return{name,writes:info.writes,reads:info.reads,lookups:info.lookups,total};
    });
    tables.sort((a,b)=>b.total-a.total);
    let filtered=tables;
    if(search.trim()){const q=search.toLowerCase();filtered=filtered.filter(t=>t.name.toLowerCase().includes(q));}
    if(filterIds){
      const sessionNames=new Set();
      Object.entries(sessionData).forEach(([n,d])=>{if(filterIds.has("S"+d.step)||filterIds.has(n))sessionNames.add(n);});
      filtered=filtered.filter(t=>t.writes.some(s=>sessionNames.has(s))||t.reads.some(s=>sessionNames.has(s))||t.lookups.some(s=>sessionNames.has(s)));
    }
    return filtered.slice(0,100);
  },[search,filterIds]);

  const sel=selTable?tableList.find(t=>t.name===selTable)||null:null;

  return (
    <div style={{display:"flex",height:"100%",overflow:"hidden"}}>
      <div style={{width:320,borderRight:"1px solid #3a4a5e",display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:8,borderBottom:"1px solid #3a4a5e"}}>
          <input type="text" placeholder="Search tables..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:"100%",padding:"5px 10px",borderRadius:5,border:"1px solid #3a4a5e",background:"rgba(0,0,0,0.3)",color:"#E2E8F0",fontSize:10,outline:"none",fontFamily:"'JetBrains Mono',monospace"}}/>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:4}}>
          {tableList.map(t=>(
            <div key={t.name} onClick={()=>setSelTable(p=>p===t.name?null:t.name)} style={{padding:"8px 10px",marginBottom:2,borderRadius:5,cursor:"pointer",background:selTable===t.name?"rgba(59,130,246,0.12)":"transparent",border:"1px solid "+(selTable===t.name?C.borderActive:"transparent"),display:"flex",alignItems:"center",gap:6}}>
              <div style={{flex:1,minWidth:0,fontSize:10,fontWeight:600,color:C.text,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
              <div style={{display:"flex",gap:3,flexShrink:0}}>
                {t.reads.length>0&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:"rgba(34,197,94,0.1)",color:C.read}}>{t.reads.length}R</span>}
                {t.writes.length>0&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:"rgba(239,68,68,0.1)",color:C.write}}>{t.writes.length}W</span>}
                {t.lookups.length>0&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:3,background:"rgba(245,158,11,0.1)",color:C.lookup}}>{t.lookups.length}L</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:16}}>
        {sel?<div>
          <div style={{fontSize:14,fontWeight:700,color:C.text,fontFamily:"'JetBrains Mono',monospace",marginBottom:12}}>{sel.name}</div>
          <div style={{display:"flex",gap:10,marginBottom:16}}>
            <div style={{background:C.surface,border:"1px solid "+C.border,borderRadius:6,padding:"8px 14px",fontSize:10}}><strong style={{color:C.text}}>{sel.total}</strong> <span style={{color:C.textDim}}>Total Refs</span></div>
          </div>
          {[{label:"WRITERS",items:sel.writes,color:C.write},{label:"READERS",items:sel.reads,color:C.read},{label:"LOOKUPS",items:sel.lookups,color:C.lookup}].filter(g=>g.items.length>0).map(g=>(
            <div key={g.label} style={{marginBottom:12}}>
              <div style={{fontSize:10,fontWeight:700,color:g.color,marginBottom:6}}>{g.label} ({g.items.length})</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{g.items.map(s=>(<span key={s} style={{fontSize:9,padding:"3px 8px",borderRadius:4,background:"rgba(255,255,255,0.04)",border:"1px solid "+C.border,color:C.text,fontFamily:"monospace"}}>{sessionData[s]?.short||s}</span>))}</div>
            </div>
          ))}
        </div>:<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",opacity:0.4}}><div style={{fontSize:12,color:C.textMuted}}>Select a table to inspect</div></div>}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: DUPLICATES
// ═══════════════════════════════════════════════════════════════════════════════

function computeTableSet(sd){return new Set([...(sd.sources||[]),...(sd.targets||[]),...(sd.lookups||[])]);}
function jaccardSimilarity(a,b){if(a.size===0&&b.size===0)return 1;let inter=0;for(const x of a)if(b.has(x))inter++;return inter/(a.size+b.size-inter);}
function computeFingerprint(sd){return[...(sd.sources||[])].sort().join("|")+"||"+[...(sd.targets||[])].sort().join("|")+"||"+[...(sd.lookups||[])].sort().join("|");}

const DuplicatesView = ({filterIds}) => {
  const [filterType,setFilterType] = useState("all");
  const [selGroup,setSelGroup] = useState(null);

  const groups = useMemo(()=>{
    const entries=Object.entries(sessionData);
    const capped=entries.slice(0,2000);
    // Exact matches via fingerprint
    const fpMap=new Map();
    capped.forEach(([name,sd])=>{
      if(filterIds&&!filterIds.has("S"+sd.step)&&!filterIds.has(name))return;
      const fp=computeFingerprint(sd);
      if(!fpMap.has(fp))fpMap.set(fp,[]);
      fpMap.get(fp).push(name);
    });
    const result=[];
    let gid=0;
    const assigned=new Set();
    for(const[,names]of fpMap){
      if(names.length>1){result.push({id:gid++,matchType:"exact",sessions:names,similarity:1.0});names.forEach(n=>assigned.add(n));}
    }
    // Near + partial via Jaccard
    const unassigned=capped.filter(([n])=>!assigned.has(n)&&(!filterIds||(filterIds.has("S"+sessionData[n].step)||filterIds.has(n))));
    const sets=unassigned.map(([n,sd])=>({name:n,tset:computeTableSet(sd)}));
    for(let i=0;i<sets.length;i++){
      for(let j=i+1;j<sets.length;j++){
        const sim=jaccardSimilarity(sets[i].tset,sets[j].tset);
        if(sim>=0.7){result.push({id:gid++,matchType:"near",sessions:[sets[i].name,sets[j].name],similarity:sim});}
        else if(sim>=0.4){result.push({id:gid++,matchType:"partial",sessions:[sets[i].name,sets[j].name],similarity:sim});}
      }
    }
    result.sort((a,b)=>b.sessions.length-a.sessions.length||b.similarity-a.similarity);
    return result;
  },[filterIds]);

  const MATCH_COLORS={exact:"#EF4444",near:"#F59E0B",partial:"#3B82F6"};
  const counts=useMemo(()=>{const c={exact:0,near:0,partial:0};groups.forEach(g=>c[g.matchType]++);return c;},[groups]);
  const filtered=filterType==="all"?groups:groups.filter(g=>g.matchType===filterType);
  const sel=selGroup!=null?groups.find(g=>g.id===selGroup):null;

  return (
    <div style={{display:"flex",height:"100%",overflow:"hidden"}}>
      <div style={{width:320,borderRight:"1px solid #3a4a5e",display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:"8px 10px",borderBottom:"1px solid #3a4a5e",display:"flex",gap:4,flexWrap:"wrap"}}>
          {[["all","All",groups.length],["exact","Exact",counts.exact],["near","Near",counts.near],["partial","Partial",counts.partial]].map(([k,l,c])=>(
            <button key={k} onClick={()=>setFilterType(k)} style={{fontSize:9,padding:"3px 8px",borderRadius:4,border:"1px solid "+(filterType===k?"#3B82F6":"#3a4a5e"),background:filterType===k?"rgba(59,130,246,0.15)":"transparent",color:filterType===k?"#60A5FA":"#8899aa",cursor:"pointer"}}>{l} ({c})</button>
          ))}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:4}}>
          {filtered.length===0&&<div style={{padding:20,textAlign:"center",color:C.textDim,fontSize:11}}>No duplicate groups found</div>}
          {filtered.map(g=>(
            <div key={g.id} onClick={()=>setSelGroup(p=>p===g.id?null:g.id)} style={{padding:"8px 10px",marginBottom:3,borderRadius:6,cursor:"pointer",background:selGroup===g.id?"rgba(59,130,246,0.12)":"transparent",border:"1px solid "+(selGroup===g.id?C.borderActive:"transparent")}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:8,padding:"1px 6px",borderRadius:3,background:MATCH_COLORS[g.matchType]+"22",color:MATCH_COLORS[g.matchType],fontWeight:700}}>{g.matchType}</span>
                <span style={{fontSize:10,color:C.text}}>{g.sessions.length} sessions</span>
                <span style={{fontSize:9,color:C.textDim,marginLeft:"auto"}}>{(g.similarity*100).toFixed(0)}%</span>
              </div>
              <div style={{fontSize:9,color:C.textDim,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.sessions.map(s=>sessionData[s]?.short||s).join(", ")}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:16}}>
        {sel?<div>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>Duplicate Group — <span style={{color:MATCH_COLORS[sel.matchType]}}>{sel.matchType}</span> ({(sel.similarity*100).toFixed(0)}%)</div>
          {sel.sessions.map(name=>{const sd=sessionData[name];if(!sd)return null;return(
            <div key={name} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:8,padding:12,marginBottom:8}}>
              <div style={{fontSize:11,fontWeight:700,color:C.text,fontFamily:"'JetBrains Mono',monospace",marginBottom:6}}>{sd.short}</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[{label:"READS",items:sd.sources,color:C.read},{label:"WRITES",items:sd.targets,color:C.write},{label:"LOOKUPS",items:sd.lookups,color:C.lookup}].map(g=>(
                  <div key={g.label}><div style={{fontSize:8,fontWeight:700,color:g.color,marginBottom:3}}>{g.label}</div>
                  {g.items.map(t=>(<div key={t} style={{fontSize:9,color:C.textMuted,fontFamily:"monospace"}}>{t}</div>))}</div>
                ))}
              </div>
            </div>
          );})}
        </div>:<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",opacity:0.4}}><div style={{fontSize:12,color:C.textMuted}}>Select a group to compare sessions</div></div>}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: INFRASTRUCTURE (Canvas)
// ═══════════════════════════════════════════════════════════════════════════════

function inferSystemFromProfile(p){
  if(!p)return null;
  const n=(p.name||"").toLowerCase();const d=(p.dbtype||"").toLowerCase();
  if(d.includes("oracle"))return{id:"oracle_"+n,name:p.name,type:"oracle",env:d.includes("cloud")?"cloud":"on-prem"};
  if(d.includes("sql server")||d.includes("mssql"))return{id:"mssql_"+n,name:p.name,type:"mssql",env:"on-prem"};
  if(d.includes("teradata"))return{id:"td_"+n,name:p.name,type:"teradata",env:"on-prem"};
  if(d.includes("s3")||d.includes("aws"))return{id:"s3_"+n,name:p.name,type:"s3",env:"aws"};
  if(d.includes("postgres"))return{id:"pg_"+n,name:p.name,type:"postgres",env:"cloud"};
  return{id:"db_"+n,name:p.name,type:"database",env:"on-prem"};
}

function inferSystemFromTableName(name){
  const n=name.toLowerCase();
  if(n.startsWith("stg_")||n.startsWith("staging"))return"staging";
  if(n.startsWith("dim_"))return"dimensions";
  if(n.startsWith("fact_"))return"facts";
  if(n.startsWith("raw_"))return"raw_layer";
  if(n.includes("tmp")||n.includes("temp"))return"temp";
  return"data_layer";
}

const SYS_ICONS={oracle:"O",mssql:"S",teradata:"T",s3:"S3",postgres:"P",kafka:"K",database:"DB",staging:"STG",dimensions:"DIM",facts:"FCT",raw_layer:"RAW",temp:"TMP",data_layer:"DL"};
const ENV_COLORS={"on-prem":"#F59E0B",aws:"#FF9900",azure:"#0078D4",gcp:"#4285F4",cloud:"#06B6D4"};

const InfrastructureView = () => {
  const canvasRef = useRef(null);
  const [selSystem,setSelSystem] = useState(null);
  const [hovSystem,setHovSystem] = useState(null);

  const {systems,edges,envGroups} = useMemo(()=>{
    const sysMap=new Map();
    // From connection profiles
    (connectionProfiles||[]).forEach(p=>{
      const s=inferSystemFromProfile(p);
      if(s&&!sysMap.has(s.id))sysMap.set(s.id,{...s,sessions:new Set(),tables:new Set()});
    });
    // From table names
    Object.keys(allTables).forEach(t=>{
      const sysType=inferSystemFromTableName(t);
      const id="sys_"+sysType;
      if(!sysMap.has(id))sysMap.set(id,{id,name:sysType.replace(/_/g," "),type:sysType,env:"on-prem",sessions:new Set(),tables:new Set()});
      sysMap.get(id).tables.add(t);
      const info=allTables[t];
      [...(info.writes||[]),...(info.reads||[]),...(info.lookups||[])].forEach(s=>sysMap.get(id).sessions.add(s));
    });
    const systems=[...sysMap.values()].map(s=>({...s,session_count:s.sessions.size,table_count:s.tables.size,sessions:[...s.sessions],tables:[...s.tables]}));
    // Edges between systems that share sessions
    const edgeMap=new Map();
    for(let i=0;i<systems.length;i++){
      for(let j=i+1;j<systems.length;j++){
        const shared=systems[i].sessions.filter(s=>systems[j].sessions.includes(s));
        if(shared.length>0){const key=systems[i].id+"->"+systems[j].id;edgeMap.set(key,{from:systems[i].id,to:systems[j].id,count:shared.length,sessions:shared});}
      }
    }
    const edges=[...edgeMap.values()];
    const envGroups={};
    systems.forEach(s=>{const e=s.env||"on-prem";if(!envGroups[e])envGroups[e]=[];envGroups[e].push(s.id);});
    return{systems,edges,envGroups};
  },[]);

  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext("2d");
    const dpr=window.devicePixelRatio||1;
    const W=600,H=500;
    canvas.width=W*dpr;canvas.height=H*dpr;
    canvas.style.width=W+"px";canvas.style.height=H+"px";
    ctx.scale(dpr,dpr);
    ctx.fillStyle=C.bg;ctx.fillRect(0,0,W,H);
    if(systems.length===0)return;
    // Circular layout
    const cx_=W/2,cy_=H/2,R=Math.min(W,H)/2-60;
    const positions=new Map();
    systems.forEach((s,i)=>{
      const angle=(2*Math.PI*i)/systems.length-Math.PI/2;
      positions.set(s.id,{x:cx_+R*Math.cos(angle),y:cy_+R*Math.sin(angle)});
    });
    // Edges
    edges.forEach(e=>{
      const f=positions.get(e.from),t=positions.get(e.to);if(!f||!t)return;
      const th=Math.min(Math.max(e.count/3,1),5);
      ctx.beginPath();ctx.moveTo(f.x,f.y);ctx.lineTo(t.x,t.y);
      ctx.strokeStyle=(hovSystem===e.from||hovSystem===e.to||selSystem===e.from||selSystem===e.to)?"rgba(96,165,250,0.6)":"rgba(148,163,184,0.15)";
      ctx.lineWidth=th;ctx.stroke();
    });
    // Nodes
    systems.forEach(s=>{
      const pos=positions.get(s.id);if(!pos)return;
      const r=Math.min(Math.max(s.session_count*2+15,20),50);
      const isActive=hovSystem===s.id||selSystem===s.id;
      const envColor=ENV_COLORS[s.env]||"#8899aa";
      ctx.beginPath();ctx.arc(pos.x,pos.y,r,0,2*Math.PI);
      ctx.fillStyle=isActive?"rgba(59,130,246,0.2)":"rgba(30,41,59,0.8)";ctx.fill();
      ctx.strokeStyle=isActive?"#60A5FA":envColor;ctx.lineWidth=isActive?3:2;ctx.stroke();
      // Icon
      ctx.fillStyle=envColor;ctx.font="bold 11px 'JetBrains Mono',monospace";ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText(SYS_ICONS[s.type]||"?",pos.x,pos.y-4);
      // Label
      ctx.fillStyle="#94A3B8";ctx.font="9px Inter,sans-serif";
      ctx.fillText(s.name.length>12?s.name.slice(0,10)+"..":s.name,pos.x,pos.y+r+12);
      // Count
      ctx.fillStyle="#60A5FA";ctx.font="bold 9px monospace";
      ctx.fillText(s.session_count+"S",pos.x,pos.y+10);
    });
  },[systems,edges,hovSystem,selSystem]);

  // Hit test for mouse interaction
  const handleCanvasClick = useCallback((e)=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const rect=canvas.getBoundingClientRect();
    const mx=e.clientX-rect.left,my=e.clientY-rect.top;
    const R=Math.min(600,500)/2-60;
    const cx_=300,cy_=250;
    let hit=null;
    systems.forEach((s,i)=>{
      const angle=(2*Math.PI*i)/systems.length-Math.PI/2;
      const x=cx_+R*Math.cos(angle),y=cy_+R*Math.sin(angle);
      const r=Math.min(Math.max(s.session_count*2+15,20),50);
      if(Math.hypot(mx-x,my-y)<=r)hit=s.id;
    });
    setSelSystem(p=>p===hit?null:hit);
  },[systems]);

  const handleCanvasMove = useCallback((e)=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const rect=canvas.getBoundingClientRect();
    const mx=e.clientX-rect.left,my=e.clientY-rect.top;
    const R=Math.min(600,500)/2-60;
    const cx_=300,cy_=250;
    let hit=null;
    systems.forEach((s,i)=>{
      const angle=(2*Math.PI*i)/systems.length-Math.PI/2;
      const x=cx_+R*Math.cos(angle),y=cy_+R*Math.sin(angle);
      const r=Math.min(Math.max(s.session_count*2+15,20),50);
      if(Math.hypot(mx-x,my-y)<=r)hit=s.id;
    });
    setHovSystem(hit);
    canvas.style.cursor=hit?"pointer":"default";
  },[systems]);

  const selSys=selSystem?systems.find(s=>s.id===selSystem):null;

  return (
    <div style={{display:"flex",height:"100%",overflow:"hidden"}}>
      <div style={{width:180,borderRight:"1px solid #3a4a5e",overflowY:"auto",padding:8,flexShrink:0}}>
        <div style={{fontSize:10,fontWeight:700,color:C.textMuted,marginBottom:8,textTransform:"uppercase"}}>Environments</div>
        {Object.entries(envGroups).map(([env,ids])=>(
          <div key={env} style={{marginBottom:10}}>
            <div style={{fontSize:9,fontWeight:700,color:ENV_COLORS[env]||"#8899aa",marginBottom:4}}>{env.toUpperCase()}</div>
            {ids.map(id=>{const s=systems.find(x=>x.id===id);return s?<div key={id} onClick={()=>setSelSystem(p=>p===id?null:id)} style={{padding:"4px 8px",borderRadius:4,cursor:"pointer",fontSize:9,color:selSystem===id?"#60A5FA":"#94A3B8",background:selSystem===id?"rgba(59,130,246,0.1)":"transparent"}}>{s.name} ({s.session_count}S)</div>:null;})}
          </div>
        ))}
      </div>
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
        <canvas ref={canvasRef} onClick={handleCanvasClick} onMouseMove={handleCanvasMove} onMouseLeave={()=>setHovSystem(null)}/>
      </div>
      <div style={{width:240,borderLeft:"1px solid #3a4a5e",overflowY:"auto",padding:12,flexShrink:0}}>
        {selSys?<div>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>{selSys.name}</div>
          <div style={{fontSize:10,color:C.textDim,marginBottom:8}}>{selSys.type} · {selSys.env}</div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <div style={{background:C.surface,border:"1px solid "+C.border,borderRadius:6,padding:"6px 10px",fontSize:10}}><strong>{selSys.session_count}</strong> <span style={{color:C.textDim}}>sessions</span></div>
            <div style={{background:C.surface,border:"1px solid "+C.border,borderRadius:6,padding:"6px 10px",fontSize:10}}><strong>{selSys.table_count}</strong> <span style={{color:C.textDim}}>tables</span></div>
          </div>
          {selSys.tables.length>0&&<div style={{marginBottom:10}}><div style={{fontSize:9,fontWeight:700,color:C.textMuted,marginBottom:4}}>TABLES</div>{selSys.tables.slice(0,20).map(t=>(<div key={t} style={{fontSize:9,color:"#60A5FA",fontFamily:"monospace",marginBottom:2}}>{t}</div>))}{selSys.tables.length>20&&<div style={{fontSize:8,color:C.textDim}}>+{selSys.tables.length-20} more</div>}</div>}
          {selSys.sessions.length>0&&<div><div style={{fontSize:9,fontWeight:700,color:C.textMuted,marginBottom:4}}>SESSIONS</div>{selSys.sessions.slice(0,20).map(s=>(<div key={s} style={{fontSize:9,color:C.text,fontFamily:"monospace",marginBottom:2}}>{sessionData[s]?.short||s}</div>))}{selSys.sessions.length>20&&<div style={{fontSize:8,color:C.textDim}}>+{selSys.sessions.length-20} more</div>}</div>}
        </div>:<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",opacity:0.4}}><div style={{fontSize:12,color:C.textMuted}}>Click a system node</div></div>}
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

const App = function App() {
  const [view,setView] = useState("tier");
  const [selectedSession,setSelectedSession] = useState(null);
  const [selectedTable,setSelectedTable] = useState(null);
  const [selectedClusterId,setSelectedClusterId] = useState(null);
  const [drillFilter,setDrillFilter] = useState({});
  const [showDrillPanel,setShowDrillPanel] = useState(false);

  // Build filter set when a cluster is selected
  const clusterFilterIds = useMemo(()=>{
    if(!selectedClusterId) return null;
    const chunk=constellationChunks.find(c=>c.id===selectedClusterId);
    if(!chunk) return null;
    return new Set(chunk.session_ids);
  },[selectedClusterId]);

  // Combined cluster + drill filter
  const drillIds = useMemo(()=>computeDrillFilterIds(drillFilter, vectorResults),[drillFilter]);
  const combinedFilterIds = useMemo(()=>{
    if(!clusterFilterIds&&!drillIds) return null;
    if(clusterFilterIds&&!drillIds) return clusterFilterIds;
    if(!clusterFilterIds&&drillIds) return drillIds;
    return new Set([...clusterFilterIds].filter(x=>drillIds.has(x)));
  },[clusterFilterIds,drillIds]);

  const activeFilterCount = Object.keys(drillFilter).filter(k=>{const v=drillFilter[k];return v!=null&&v!==false&&!(Array.isArray(v)&&v.length===0);}).length;

  const views = [
    {id:"tier",label:"Tier Diagram",icon:"▤"},
    ...(hasConstellation?[{id:"constellation",label:"Constellation",icon:"✦"}]:[]),
    {id:"explorer",label:"Explorer",icon:"◎"},
    {id:"tables",label:"Tables",icon:"☷"},
    {id:"conflicts",label:"Conflicts & Chains",icon:"⚠"},
    {id:"order",label:"Exec Order",icon:"↓"},
    {id:"matrix",label:"Relationship Matrix",icon:"⊞"},
    {id:"duplicates",label:"Duplicates",icon:"≡"},
    ...(hasComplexity?[{id:"complexity",label:"Complexity",icon:"▣"}]:[]),
    ...(hasWavePlan?[{id:"waves",label:"Waves",icon:"≋"}]:[]),
    ...(hasComplexity?[{id:"heatmap",label:"Heat Map",icon:"▓"}]:[]),
    ...(hasConcentration?[{id:"concentration",label:"Gravity",icon:"⊕"}]:[]),
    ...(hasEnsemble?[{id:"consensus",label:"Consensus",icon:"◈"}]:[]),
    {id:"infra",label:"Infrastructure",icon:"⬡"},
  ].filter(v=>iv(v.id));

  const noPaddingViews=new Set(["tier","matrix","constellation","duplicates","tables","infra","heatmap"]);

  return (
    <div style={{width:"100%",height:"100vh",background:C.bg,color:C.text,fontFamily:"'Inter',-apple-system,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"10px 20px",borderBottom:"1px solid #3a4a5e",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,background:"rgba(26,35,50,0.9)",backdropFilter:"blur(12px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{fontSize:15,fontWeight:800,letterSpacing:"-0.02em"}}>Lakehouse Optimizer</span>
          <span style={{fontSize:12,color:"#8899aa"}}>Session Dependency Diagram</span>
          <div style={{display:"flex",gap:2,marginLeft:8,flexWrap:"wrap"}}>
            {views.map(v=>(<button key={v.id} onClick={()=>setView(v.id)} style={{padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,background:view===v.id?"rgba(59,130,246,0.2)":"transparent",color:view===v.id?"#60A5FA":"#8899aa",transition:"all 0.15s"}}>{v.icon} {v.label}</button>))}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          {hasVectors&&<button onClick={()=>setShowDrillPanel(p=>!p)} style={{padding:"4px 12px",borderRadius:6,border:"1px solid "+(showDrillPanel||activeFilterCount>0?"#3B82F6":"#3a4a5e"),background:showDrillPanel?"rgba(59,130,246,0.15)":"transparent",color:showDrillPanel||activeFilterCount>0?"#60A5FA":"#8899aa",cursor:"pointer",fontSize:10,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
            Filters{activeFilterCount>0&&<span style={{background:"#3B82F6",color:"#fff",borderRadius:"50%",width:16,height:16,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:800}}>{activeFilterCount}</span>}
          </button>}
          {selectedClusterId&&(
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"4px 12px",borderRadius:6,background:"rgba(59,130,246,0.1)",border:"1px solid rgba(59,130,246,0.3)"}}>
              <span style={{fontSize:10,color:"#60A5FA"}}>Viewing cluster: {constellationChunks.find(c=>c.id===selectedClusterId)?.label||selectedClusterId}</span>
              <button onClick={()=>setSelectedClusterId(null)} style={{background:"transparent",border:"none",color:"#60A5FA",cursor:"pointer",fontSize:11}}>✕</button>
            </div>
          )}
          {(view==="tier"||view==="matrix")&&<div style={{display:"flex",gap:10,fontSize:9}}>
            {Object.entries(connTypes).map(([k,ct])=>(<div key={k} style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:14,height:ct.baseWidth+1,borderRadius:1,background:ct.color,...(ct.dash?{backgroundImage:"repeating-linear-gradient(90deg,"+ct.color+" 0px,"+ct.color+" 3px,transparent 3px,transparent 6px)"}:{})}}/><span style={{color:"#94A3B8"}}>{ct.label}</span></div>))}
          </div>}
          <span style={{fontSize:9,color:"#5a6a7a",fontFamily:"monospace"}}>{exportTimestamp}</span>
        </div>
      </div>
      <div style={{padding:"6px 20px",borderBottom:"1px solid #3a4a5e",display:"flex",gap:20,fontSize:10,color:"#8899aa",flexShrink:0}}>
        <span><strong style={{color:"#E2E8F0"}}>{tierStats.session_count}</strong> Sessions</span>
        <span><strong style={{color:"#10B981"}}>{tierStats.source_tables}</strong> Sources</span>
        {tierStats.write_conflicts>0&&<span style={{color:"#EF4444"}}><strong>{tierStats.write_conflicts}</strong> Conflicts</span>}
        {tierStats.dep_chains>0&&<span style={{color:"#F97316"}}><strong>{tierStats.dep_chains}</strong> Chains</span>}
        {tierStats.staleness_risks>0&&<span style={{color:"#F59E0B"}}><strong>{tierStats.staleness_risks}</strong> Stale Lookups</span>}
        <span style={{color:"#94A3B8"}}><strong style={{color:"#E2E8F0"}}>{tierStats.max_tier}</strong> Tier Depth</span>
      </div>
      <div style={{flex:1,overflow:"hidden",display:"flex"}}>
        {showDrillPanel&&hasVectors&&<div style={{width:240,borderRight:"1px solid #3a4a5e",flexShrink:0,overflow:"hidden"}}>
          <DrillThroughPanel filter={drillFilter} onFilterChange={setDrillFilter} matchingCount={combinedFilterIds?combinedFilterIds.size:null}/>
        </div>}
        <div style={{flex:1,overflow:"hidden",padding:noPaddingViews.has(view)?0:20}}>
          {view==="explorer"&&<ExplorerView selectedSession={selectedSession} setSelectedSession={setSelectedSession} selectedTable={selectedTable} setSelectedTable={setSelectedTable} filterIds={combinedFilterIds}/>}
          {view==="conflicts"&&<ConflictsView filterIds={combinedFilterIds}/>}
          {view==="order"&&<OrderView filterIds={combinedFilterIds}/>}
          {view==="tier"&&<TierDiagram filterIds={combinedFilterIds}/>}
          {view==="matrix"&&<MatrixView filterIds={combinedFilterIds}/>}
          {view==="constellation"&&hasConstellation&&<ConstellationView onSelectCluster={setSelectedClusterId} selectedClusterId={selectedClusterId}/>}
          {view==="complexity"&&<ComplexityView filterIds={combinedFilterIds}/>}
          {view==="waves"&&<WavePlanView filterIds={combinedFilterIds}/>}
          {view==="heatmap"&&<HeatMapView filterIds={combinedFilterIds}/>}
          {view==="concentration"&&<ConcentrationView filterIds={combinedFilterIds}/>}
          {view==="consensus"&&<ConsensusRadarView filterIds={combinedFilterIds}/>}
          {view==="tables"&&<TableExplorerView filterIds={combinedFilterIds}/>}
          {view==="duplicates"&&<DuplicatesView filterIds={combinedFilterIds}/>}
          {view==="infra"&&<InfrastructureView/>}
        </div>
      </div>
    </div>
  );
}

const root=ReactDOM.createRoot(document.getElementById("root"));root.render(<App/>);
<\/script></body></html>`;
}

/** Trigger download of the HTML string as a file */
export function downloadTierMapHTML(data: TierMapResult, constellation?: ConstellationResult, vectorResults?: VectorResults | null, filename?: string, selectedViews?: Set<string>): void {
  const html = buildTierMapHTML(data, constellation, vectorResults, selectedViews);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'tier_map_export.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
