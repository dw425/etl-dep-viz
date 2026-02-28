/**
 * exportTierMapHTML.ts — Generates a self-contained interactive HTML document
 * matching the Lumen_Retro reference format: React 18 + Babel from CDN,
 * 5 views (Tier Diagram, Explorer, Conflicts, Exec Order, Matrix),
 * all with hover/click/selection interactivity.
 *
 * Data from TierMapResult replaces the hardcoded values.
 */

import type { TierMapResult } from '../../types/tiermap';

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
      // Session → Table = write/chain target
      if (c.from === s.id && tableIdToName.has(c.to)) {
        const tName = tableIdToName.get(c.to)!;
        if (!targets.includes(tName)) targets.push(tName);
      }
      // Table → Session = read/lookup source
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

export function buildTierMapHTML(data: TierMapResult): string {
  const sessionData = buildSessionData(data);
  const execOrder = data.sessions.slice().sort((a, b) => a.step - b.step).map(s => s.full);

  const sessionDataJSON = JSON.stringify(sessionData, null, 2);
  const execOrderJSON = JSON.stringify(execOrder);
  const tierSessionsJSON = JSON.stringify(data.sessions);
  const tierTablesJSON = JSON.stringify(data.tables);
  const tierConnectionsJSON = JSON.stringify(data.connections);
  const statsJSON = JSON.stringify(data.stats);
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Tier Map — Session Dependency Diagram</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;background:#080C14}#root{width:100vw;height:100vh}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#475569}</style>
</head><body><div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js"><\/script>
<script type="text/babel">
const{useState,useCallback,useMemo,useRef,useEffect}=React;

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER — injected from TierMapResult
// ═══════════════════════════════════════════════════════════════════════════════

const sessionData = ${sessionDataJSON};
const executionOrder = ${execOrderJSON};
const tierSessions = ${tierSessionsJSON};
const tierTables = ${tierTablesJSON};
const tierConnections = ${tierConnectionsJSON};
const tierStats = ${statsJSON};
const exportTimestamp = "${timestamp}";

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

const C = {bg:"#080C14",surface:"#111827",border:"#1e293b",borderActive:"#3b82f6",text:"#e2e8f0",textMuted:"#64748b",textDim:"#475569",write:"#ef4444",read:"#22c55e",lookup:"#f59e0b",conflict:"#ef4444",chain:"#a855f7",accentBlue:"#60a5fa"};

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

const ExplorerView = ({selectedSession,setSelectedSession,selectedTable,setSelectedTable}) => {
  const sel = selectedSession ? sessionData[selectedSession] : null;
  const connSessions = useMemo(()=>{
    if(!selectedTable) return new Set();
    const s=new Set();
    Object.entries(sessionData).forEach(([n,d])=>{if(d.sources.includes(selectedTable)||d.targets.includes(selectedTable)||d.lookups.includes(selectedTable))s.add(n);});
    return s;
  },[selectedTable]);

  const Badge = ({name,type,onClick:oc}) => {
    const cm={write:C.write,read:C.read,lookup:C.lookup};
    const bm={write:"rgba(239,68,68,0.08)",read:"rgba(34,197,94,0.08)",lookup:"rgba(245,158,11,0.08)"};
    const hi=selectedTable===name;
    return <span onClick={oc} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10,fontFamily:"'JetBrains Mono',monospace",padding:"3px 8px",borderRadius:5,background:hi?"rgba(59,130,246,0.2)":bm[type]||"transparent",color:hi?C.accentBlue:cm[type]||C.textMuted,border:"1px solid "+(hi?"rgba(59,130,246,0.4)":type==="write"&&writeConflicts[name]?"rgba(239,68,68,0.5)":"transparent"),cursor:"pointer",fontWeight:hi?700:500,whiteSpace:"nowrap"}}>{type==="write"&&writeConflicts[name]&&<span style={{color:C.conflict}}>⚠ </span>}{name}</span>;
  };

  return (
    <div style={{display:"flex",gap:16,height:"100%",overflow:"hidden"}}>
      <div style={{width:320,flexShrink:0,display:"flex",flexDirection:"column",gap:8,overflowY:"auto",paddingRight:8}}>
        <div style={{fontSize:10,fontWeight:700,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.1em",padding:"0 4px",marginBottom:4}}>Sessions ({executionOrder.length})</div>
        {executionOrder.map(name=>{
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

const ConflictsView = () => (
  <div style={{overflowY:"auto",height:"100%"}}>
    <div style={{marginBottom:24}}>
      <div style={{fontSize:13,fontWeight:700,color:C.conflict,marginBottom:4,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>⚠</span> Write-Write Conflicts ({Object.keys(writeConflicts).length})</div>
      <div style={{fontSize:10,color:C.textDim,marginBottom:12}}>Multiple sessions writing to the same target — validation depends on execution order</div>
      {Object.entries(writeConflicts).map(([t,w])=>(<div key={t} style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:8,padding:14,marginBottom:10}}><div style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.write,marginBottom:8}}>{t}</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{w.map(s=>(<span key={s} style={{fontSize:10,padding:"4px 10px",borderRadius:5,background:C.surface,color:C.text,border:"1px solid "+C.border}}>{sessionData[s]?.short||s}</span>))}</div></div>))}
    </div>
    <div style={{marginBottom:24}}>
      <div style={{fontSize:13,fontWeight:700,color:C.chain,marginBottom:4,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:16}}>⛓</span> Read-After-Write Chains ({Object.keys(readAfterWrite).length})</div>
      <div style={{fontSize:10,color:C.textDim,marginBottom:12}}>Reader MUST run after writer</div>
      {Object.entries(readAfterWrite).map(([t,{writers:w,readers:r}])=>(<div key={t} style={{background:"rgba(168,85,247,0.06)",border:"1px solid rgba(168,85,247,0.2)",borderRadius:8,padding:14,marginBottom:10}}><div style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.chain,marginBottom:10}}>{t}</div><div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}><div><div style={{fontSize:8,color:C.textDim,textTransform:"uppercase",marginBottom:4}}>Writers</div><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{w.map(x=>(<span key={x} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"rgba(239,68,68,0.1)",color:C.write,fontFamily:"monospace"}}>{sessionData[x]?.short||x}</span>))}</div></div><div style={{fontSize:18,color:C.chain}}>→</div><div><div style={{fontSize:8,color:C.textDim,textTransform:"uppercase",marginBottom:4}}>Readers</div><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{r.map(x=>(<span key={x} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"rgba(34,197,94,0.1)",color:C.read,fontFamily:"monospace"}}>{sessionData[x]?.short||x}</span>))}</div></div></div></div>))}
    </div>
  </div>
);


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 3: EXECUTION ORDER
// ═══════════════════════════════════════════════════════════════════════════════

const OrderView = () => (
  <div style={{overflowY:"auto",height:"100%"}}>
    <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>Recommended Execution Order</div>
    <div style={{fontSize:10,color:C.textDim,marginBottom:16}}>Respects all read-after-write chains and write conflicts</div>
    {executionOrder.map((name,i)=>{const s=sessionData[name];if(!s)return null;const hc=s.targets.some(t=>writeConflicts[t]);const hch=s.targets.some(t=>readAfterWrite[t]);return(
      <div key={name} style={{display:"flex",alignItems:"stretch",marginBottom:2}}>
        <div style={{width:48,display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0}}>
          <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:hc?"rgba(239,68,68,0.15)":hch?"rgba(168,85,247,0.15)":"rgba(59,130,246,0.15)",border:"2px solid "+(hc?C.conflict:hch?C.chain:"#3b82f6"),fontSize:11,fontWeight:700,color:hc?C.conflict:hch?C.chain:"#3b82f6",fontFamily:"monospace"}}>{i+1}</div>
          {i<executionOrder.length-1&&<div style={{flex:1,width:2,background:C.border,minHeight:24}}/>}
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


// ═══════════════════════════════════════════════════════════════════════════════
// VIEW 4: TIER DIAGRAM
// ═══════════════════════════════════════════════════════════════════════════════

const TierDiagram = () => {
  const containerRef = useRef(null);
  const nodeRefs = useRef({});
  const [lines,setLines] = useState([]);
  const [svgDims,setSvgDims] = useState({w:0,h:0});
  const [hov,setHov] = useState(null);
  const [sel,setSel] = useState(null);
  const [hiddenTiers,setHiddenTiers] = useState(()=>new Set());
  const regRef = useCallback((id,el)=>{if(el)nodeRefs.current[id]=el;},[]);

  // Map every node id to its tier for connection filtering
  const nodeTierMap = useMemo(()=>{
    const m=new Map();
    tierSessions.forEach(s=>m.set(s.id,s.tier));
    tierTables.forEach(t=>m.set(t.id,t.tier));
    return m;
  },[]);

  // Only connections where both endpoints belong to a visible tier
  const activeConns = useMemo(()=>
    tierConnections.filter(cn=>{
      const fT=nodeTierMap.get(cn.from);
      const tT=nodeTierMap.get(cn.to);
      return fT!==undefined&&!hiddenTiers.has(fT)&&tT!==undefined&&!hiddenTiers.has(tT);
    })
  ,[hiddenTiers,nodeTierMap]);

  // Visible tier groups
  const visibleGroups = useMemo(()=>tGroupsData.filter(g=>!hiddenTiers.has(g.tier)),[hiddenTiers]);

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
                    <div style={{fontSize:8,color:"#64748B",marginTop:2,textTransform:"uppercase",letterSpacing:"0.05em"}}>{t.type}</div>
                  </div>
                );})}
              </div>
            </div>
          );})}
        </div>
      </div>
      <div style={{width:260,borderLeft:"1px solid #1E293B",background:"rgba(15,23,42,0.6)",overflowY:"auto",flexShrink:0,display:"flex",flexDirection:"column"}}>

        {/* Tier Visibility toggles */}
        <div style={{padding:"10px 14px",borderBottom:"1px solid #1E293B",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:10,fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.1em"}}>Tier Visibility</div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>setHiddenTiers(new Set())} style={{fontSize:8,padding:"2px 6px",borderRadius:3,border:"1px solid #1E293B",background:"transparent",color:"#64748B",cursor:"pointer"}}>All</button>
              <button onClick={()=>setHiddenTiers(new Set(tGroupsData.map(g=>g.tier)))} style={{fontSize:8,padding:"2px 6px",borderRadius:3,border:"1px solid #1E293B",background:"transparent",color:"#64748B",cursor:"pointer"}}>None</button>
            </div>
          </div>
          {tGroupsData.map(g=>{
            const cfg=getTierCfg(g.tier);
            const hidden=hiddenTiers.has(g.tier);
            const toggle=()=>setHiddenTiers(prev=>{const next=new Set(prev);next.has(g.tier)?next.delete(g.tier):next.add(g.tier);return next;});
            return(
              <div key={g.tier} onClick={toggle} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5,cursor:"pointer",userSelect:"none",overflow:"hidden"}}>
                <div style={{width:16,height:16,minWidth:16,borderRadius:3,flexShrink:0,border:"2px solid "+(hidden?"#475569":cfg.color),background:hidden?"transparent":cfg.color,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s"}}>
                  {!hidden&&<span style={{color:"#fff",fontSize:9,fontWeight:900,lineHeight:1}}>✓</span>}
                </div>
                <div style={{fontSize:8,color:hidden?"#475569":"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",width:0,flexGrow:1,transition:"color 0.15s"}}>{cfg.label}</div>
                <div style={{fontSize:8,fontFamily:"monospace",color:hidden?"#475569":cfg.color,flexShrink:0,whiteSpace:"nowrap"}}>
                  {g.sessions.length>0?g.sessions.length+"S":""}{g.sessions.length>0&&g.tables.length>0?"+":""}{g.tables.length>0?g.tables.length+"T":""}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{padding:"12px 14px",borderBottom:"1px solid #1E293B",flexShrink:0}}><div style={{fontSize:10,fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.1em"}}>Node Detail</div></div>
        {sel?(()=>{const s=tierSessions.find(x=>x.id===sel);const t=tierTables.find(x=>x.id===sel);const nd=s||t;if(!nd)return null;const outs=activeConns.filter(c=>c.from===sel);const ins=activeConns.filter(c=>c.to===sel);return(
          <div style={{padding:14,flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:"#E2E8F0",fontFamily:"'JetBrains Mono',monospace",marginBottom:4}}>{nd.name}</div>
            {s&&<div style={{fontSize:9,color:"#64748B",marginBottom:12,fontFamily:"monospace",wordBreak:"break-all"}}>{s.full}</div>}
            {t&&<div style={{fontSize:9,color:"#64748B",marginBottom:12}}>{t.type} · tier {t.tier}</div>}
            {outs.length>0&&<div style={{marginBottom:12}}><div style={{fontSize:9,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",marginBottom:6}}>Outputs → ({outs.length})</div>{outs.map((c,i)=>{const tgt=[...tierSessions,...tierTables].find(x=>x.id===c.to);const ct=connTypes[c.type]||connTypes.write_clean;return(<div key={i} style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}><div style={{width:8,height:3,borderRadius:1,background:ct.color,flexShrink:0}}/><span style={{fontSize:9,color:ct.color,fontWeight:600,flexShrink:0}}>{c.type.replace(/_/g," ")}</span><span style={{fontSize:9,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>→ {tgt?.name||c.to}</span></div>);})}</div>}
            {ins.length>0&&<div style={{marginBottom:12}}><div style={{fontSize:9,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",marginBottom:6}}>Inputs ← ({ins.length})</div>{ins.map((c,i)=>{const src=[...tierSessions,...tierTables].find(x=>x.id===c.from);const ct=connTypes[c.type]||connTypes.write_clean;return(<div key={i} style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}><div style={{width:8,height:3,borderRadius:1,background:ct.color,flexShrink:0}}/><span style={{fontSize:9,color:ct.color,fontWeight:600,flexShrink:0}}>{c.type.replace(/_/g," ")}</span><span style={{fontSize:9,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>← {src?.name||c.from}</span></div>);})}</div>}
          </div>
        );})():<div style={{padding:20,color:"#475569",fontSize:11,textAlign:"center",flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}>Click a node to inspect</div>}
        <div style={{padding:"10px 14px",borderTop:"1px solid #1E293B",flexShrink:0}}>
          <div style={{fontSize:9,fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Connection Density</div>
          {[...tierSessions,...tierTables].filter(n=>(connCounts[n.id]||0)>0).sort((a,b)=>(connCounts[b.id]||0)-(connCounts[a.id]||0)).slice(0,12).map(n=>(
            <div key={n.id} style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
              <div style={{fontSize:8,color:"#64748B",width:12,textAlign:"right",fontFamily:"monospace"}}>{connCounts[n.id]||0}</div>
              <div style={{flex:1,height:5,borderRadius:2,background:"#1E293B",overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,width:Math.min((connCounts[n.id]||0)/8*100,100)+"%",background:(connCounts[n.id]||0)>4?"#EF4444":(connCounts[n.id]||0)>2?"#F59E0B":"#3B82F6"}}/></div>
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

const MatrixView = () => {
  const [hov,setHov] = useState(null);
  const cl=(t)=>({write_conflict:"W⚠",write_clean:"W",read_after_write:"R",lookup_stale:"L",chain:"⛓",source_read:"SR"}[t]||"?");
  return (
    <div style={{height:"100%",overflow:"auto",padding:24}}>
      <div style={{fontSize:18,fontWeight:700,color:"#E2E8F0",marginBottom:6}}>Many-to-Many Relationship Matrix</div>
      <div style={{fontSize:14,color:"#64748B",marginBottom:16}}>Sessions (rows) × Tables (columns) — hover to highlight</div>
      <div style={{display:"flex",gap:16,marginBottom:20,flexWrap:"wrap"}}>
        {Object.entries(connTypes).map(([k,ct])=>(<div key={k} style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:36,height:28,borderRadius:5,fontSize:14,fontWeight:800,background:ct.color+"33",color:ct.color,border:"1px solid "+ct.color+"66",display:"flex",alignItems:"center",justifyContent:"center"}}>{cl(k)}</div><span style={{fontSize:13,color:"#94A3B8"}}>{ct.label}</span></div>))}
      </div>
      <div style={{overflowX:"auto"}}>
        <table style={{borderCollapse:"collapse",fontSize:14,fontFamily:"'JetBrains Mono',monospace"}}>
          <thead><tr>
            <th style={{padding:"10px 16px",background:"#1E293B",color:"#64748B",position:"sticky",left:0,zIndex:2,textAlign:"left",borderBottom:"2px solid #334155",fontSize:13}}>Session ↓ / Table →</th>
            {tierTables.map(t=>(<th key={t.id} onMouseEnter={()=>setHov(t.id)} onMouseLeave={()=>setHov(null)} style={{padding:"8px 8px",background:hov===t.id?"rgba(255,255,255,0.1)":"#1E293B",color:hov===t.id?"#fff":"#94A3B8",cursor:"pointer",writingMode:"vertical-lr",textOrientation:"mixed",minWidth:48,borderBottom:"2px solid #334155",borderRight:"1px solid #1a1f2e",fontWeight:t.type==="conflict"?700:500,fontSize:13,maxHeight:200}}>{t.name}</th>))}
          </tr></thead>
          <tbody>{tierSessions.map(s=>{const cfg=getTierCfg(s.tier);return(<tr key={s.id}>
            <td onMouseEnter={()=>setHov(s.id)} onMouseLeave={()=>setHov(null)} style={{padding:"12px 16px",background:hov===s.id?"rgba(255,255,255,0.1)":"#111827",color:hov===s.id?"#fff":cfg.color,position:"sticky",left:0,zIndex:1,cursor:"pointer",borderBottom:"1px solid #1a1f2e",fontWeight:600,whiteSpace:"nowrap",fontSize:14}}><span style={{color:"#64748B",marginRight:6}}>S{s.step}</span>{s.name}</td>
            {tierTables.map(t=>{const m=tierConnections.filter(c=>(c.from===s.id&&c.to===t.id)||(c.from===t.id&&c.to===s.id));const hi=hov===s.id||hov===t.id;return(
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
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════

const App = function App() {
  const [view,setView] = useState("tier");
  const [selectedSession,setSelectedSession] = useState(null);
  const [selectedTable,setSelectedTable] = useState(null);
  const views = [
    {id:"tier",label:"Tier Diagram",icon:"▤"},
    {id:"explorer",label:"Explorer",icon:"◎"},
    {id:"conflicts",label:"Conflicts & Chains",icon:"⚠"},
    {id:"order",label:"Exec Order",icon:"↓"},
    {id:"matrix",label:"Relationship Matrix",icon:"⊞"},
  ];

  return (
    <div style={{width:"100%",height:"100vh",background:C.bg,color:C.text,fontFamily:"'Inter',-apple-system,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"10px 20px",borderBottom:"1px solid #1E293B",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,background:"rgba(15,23,42,0.9)",backdropFilter:"blur(12px)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{fontSize:15,fontWeight:800,letterSpacing:"-0.02em"}}>Tier Map</span>
          <span style={{fontSize:12,color:"#64748B"}}>Session Dependency Diagram</span>
          <div style={{display:"flex",gap:2,marginLeft:8}}>
            {views.map(v=>(<button key={v.id} onClick={()=>setView(v.id)} style={{padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,background:view===v.id?"rgba(59,130,246,0.2)":"transparent",color:view===v.id?"#60A5FA":"#64748B",transition:"all 0.15s"}}>{v.icon} {v.label}</button>))}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          {(view==="tier"||view==="matrix")&&<div style={{display:"flex",gap:10,fontSize:9}}>
            {Object.entries(connTypes).map(([k,ct])=>(<div key={k} style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:14,height:ct.baseWidth+1,borderRadius:1,background:ct.color,...(ct.dash?{backgroundImage:"repeating-linear-gradient(90deg,"+ct.color+" 0px,"+ct.color+" 3px,transparent 3px,transparent 6px)"}:{})}}/><span style={{color:"#94A3B8"}}>{ct.label}</span></div>))}
          </div>}
          <span style={{fontSize:9,color:"#475569",fontFamily:"monospace"}}>{exportTimestamp}</span>
        </div>
      </div>
      <div style={{padding:"6px 20px",borderBottom:"1px solid #1E293B",display:"flex",gap:20,fontSize:10,color:"#64748B",flexShrink:0}}>
        <span><strong style={{color:"#E2E8F0"}}>{tierStats.session_count}</strong> Sessions</span>
        <span><strong style={{color:"#10B981"}}>{tierStats.source_tables}</strong> Sources</span>
        {tierStats.write_conflicts>0&&<span style={{color:"#EF4444"}}><strong>{tierStats.write_conflicts}</strong> Conflicts</span>}
        {tierStats.dep_chains>0&&<span style={{color:"#F97316"}}><strong>{tierStats.dep_chains}</strong> Chains</span>}
        {tierStats.staleness_risks>0&&<span style={{color:"#F59E0B"}}><strong>{tierStats.staleness_risks}</strong> Stale Lookups</span>}
        <span style={{color:"#94A3B8"}}><strong style={{color:"#E2E8F0"}}>{tierStats.max_tier}</strong> Tier Depth</span>
      </div>
      <div style={{flex:1,overflow:"hidden",padding:view==="tier"||view==="matrix"?0:20}}>
        {view==="explorer"&&<ExplorerView selectedSession={selectedSession} setSelectedSession={setSelectedSession} selectedTable={selectedTable} setSelectedTable={setSelectedTable}/>}
        {view==="conflicts"&&<ConflictsView/>}
        {view==="order"&&<OrderView/>}
        {view==="tier"&&<TierDiagram/>}
        {view==="matrix"&&<MatrixView/>}
      </div>
    </div>
  );
}

const root=ReactDOM.createRoot(document.getElementById("root"));root.render(<App/>);
<\/script></body></html>`;
}

/** Trigger download of the HTML string as a file */
export function downloadTierMapHTML(data: TierMapResult, filename?: string): void {
  const html = buildTierMapHTML(data);
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
