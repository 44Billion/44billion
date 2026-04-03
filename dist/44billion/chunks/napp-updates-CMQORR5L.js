import"./chunk-KOZLJ5I3.js";import{a as B}from"./chunk-HUBF4WZE.js";import{j as N,q as T}from"./chunk-TG3GHENF.js";import{e as I}from"./chunk-4YEM5IRY.js";import"./chunk-RQVJ5QEZ.js";import{b as O,e as r,f as E}from"./chunk-LLMC3MZB.js";import{g as S,j as d,n as A,o as M,v as U}from"./chunk-5XJKKVB7.js";S("icon-arrow-narrow-right",function(){let f=M({path$:["M5 12l14 0","M15 16l4 -4","M15 8l4 4"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...f,...this.props}}
  />`});S("icon-hourglass-high",function(){let f=M({path$:["M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z","M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...f,...this.props}}
  />`});S("napp-updates",function(){let f=O(localStorage),{session_unread_appUpdateCount$:v}=f;U(()=>{v(void 0)});let k=A(()=>{let t=f.session_workspaceKeys$()||[],o=new Set;return t.forEach(n=>{let e=f[`session_workspaceByKey_${n}_pinnedAppIds$`]()||[],s=f[`session_workspaceByKey_${n}_unpinnedAppIds$`]()||[];e.forEach(a=>o.add(a)),s.forEach(a=>o.add(a))}),Array.from(o)}),P=d({}),c=d({}),l=d({}),g=d(!1),$=d(0),m=A(()=>Object.keys(c()).length),w=d(0),z=A(()=>w()<k().length),y=d(!1),i=A(()=>{let t=c(),o=l();return Object.keys(t).filter(n=>{let e=o[n]?.status;return e!=="updating"&&e!=="pending"&&e!=="done"})}),h=async()=>{if(y())return;y(!0);let t=k();try{let o=await B.searchForUpdates(t);c(n=>{let e={...n},s=l();return Object.entries(o).forEach(([a,p])=>{let _=s[a]?.status;_==="updating"||_==="pending"||(e[a]=p,s[a]?.status==="error"&&l(j=>{let x={...j};return delete x[a],x}))}),e})}catch(o){console.error("Error checking for updates",o)}finally{w(t.length),y(!1)}};U(async()=>{await h();let t=k(),o=await Promise.all(t.map(e=>T.create(e).catch(()=>null))),n=new Set;if(o.forEach(e=>{e?.siteManifest?.pubkey&&n.add(e.siteManifest.pubkey)}),Object.values(c()).forEach(e=>{e.event?.pubkey&&n.add(e.event.pubkey)}),n.size>0)try{let e=await N({kinds:[0],authors:Array.from(n)},{code:"WRITE_RELAYS"}),s={};e.forEach(a=>{try{s[a.pubkey]=JSON.parse(a.content)}catch{}}),P(s)}catch(e){console.error("Bulk fetch failed",e)}});let b=async()=>{if(g())return;let t=i();if(t.length===0)return;g(!0);let o=c(),n=t.map(e=>o[e].event);l(e=>{let s={...e};return t.forEach(a=>{s[a]={status:"pending",progress:0,error:null}}),s});try{for await(let e of B.updateApps(n)){let{appId:s,appProgress:a,error:p,overallProgress:_}=e;$(_);let j=p?"error":a===100?"done":"updating";l(x=>({...x,[s]:{status:j,progress:a,error:p}})),j==="done"&&c(x=>{if(!x[s])return x;let C={...x};return delete C[s],C})}l(e=>{let s={...e},a=!1;return t.forEach(p=>{s[p]&&s[p].status!=="done"&&s[p].status!=="error"&&(s[p]={...s[p],status:"done",progress:100},a=!0)}),a?s:e}),c(e=>{let s={...e},a=!1;return t.forEach(p=>{s[p]&&l()[p]?.status==="done"&&(delete s[p],a=!0)}),a?s:e}),v(Object.keys(c()).length||void 0)}catch(e){console.error("Update all failed",e)}finally{g(!1),$(0)}},u=async t=>{let o=c()[t];if(!o)return;let n=l()[t]?.status;if(!(n==="updating"||n==="pending")){l(e=>({...e,[t]:{status:"updating",progress:0,error:null}}));try{for await(let e of B.updateApp(o.event))l(s=>({...s,[t]:{status:e.error?"error":"updating",progress:e.appProgress,error:e.error}}));l(e=>({...e,[t]:{status:"done",progress:100,error:null}})),c(e=>{let s={...e};return delete s[t],s}),v(Object.keys(c()).length||void 0)}catch(e){l(s=>({...s,[t]:{status:"error",error:e,progress:0}}))}}};return this.h`
    <style>${`
      napp-updates {
        flex-grow: 1; /* use max width available */
        max-width: 900px;
        display: flex !important;
        flex-direction: column;
        height: 100%;
      }

      .header-1kuhvcxd8b {
        background-color: ${r.colors.bg};
        color: ${r.colors.fg};
        height: 55px;
        display: flex;
        align-items: center;
        padding: 0 10px;
        flex-shrink: 0;

        .btn-wrapper-136713 {
          position: relative;
          bottom: 1px;
          height: 100%;
          display: flex;
          min-width: 34px;

          & button {
            padding-right: 4px;
          }
        }

        .title-gd7a98 {
          flex-grow: 1;
          font-weight: 500;
          font-size: 18rem;
        }

        .actions-wrapper {
          display: flex;
          gap: 8px;
          align-items: center;
        }
      }

      .body-cydfv983dfff {
        flex-grow: 1; /* take remaining height */
        display: flex;
        gap: 13px;
        flex-direction: column;
        overflow-y: auto;
        padding: 10px 0;
      }

      .action-btn {
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 14rem;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.2s, opacity 0.2s;
        border: none;
        background-color: ${r.colors.bg2};
        color: ${r.colors.fg};
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background-color: ${r.colors.bg3};
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .update-all-btn {
        background-color: ${r.colors.bgAccentPrimary};
        color: ${r.colors.fgAccent};

        &:hover {
          filter: brightness(1.1);
          background-color: ${r.colors.bgAccentPrimary};
        }
      }

      .desktop-update-all {
        @media ${E.breakpoints.mobile} {
          display: none;
        }
      }

      .mobile-updates-bar {
        display: none;
        @media ${E.breakpoints.mobile} {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 20px;
          font-weight: 500;
          color: ${r.colors.fg};
        }
      }

      .no-updates-bar {
        display: flex;
        padding: 10px 20px;
        font-style: italic;
        color: ${r.colors.fg2};
      }

      .search-text {
        @media ${E.breakpoints.mobile} {
          display: none;
        }
      }

      .search-icon {
        display: none;
        @media ${E.breakpoints.mobile} {
          display: flex;
        }
      }

      @keyframes spin { 100% { transform: rotate(360deg); } }
      .spinning { animation: spin 1s linear infinite; }
    `}</style>
    <div class='header-1kuhvcxd8b'>
      <div class='btn-wrapper-136713'>
        <back-btn />
      </div>
      <div class='title-gd7a98'>App Updates</div>
      <div class="actions-wrapper">
        <button class="action-btn" onclick=${h} disabled=${y()}>
          <span class="search-text">${y()?"Searching...":"Search for Updates"}</span>
          <span class=${`search-icon ${y()?"spinning":""}`}><icon-reload props=${{size:"20px"}} /></span>
        </button>
        ${m()>0&&!g()?this.h`<button class="action-btn update-all-btn desktop-update-all" onclick=${b} disabled=${i().length===0}>Update All</button>`:""}
        ${g()?this.h`<div class="desktop-update-all" style=${`font-size:14rem;color:${r.colors.fg2}`}>Updating... ${$()}%</div>`:""}
      </div>
    </div>
    ${m()>0?this.h`
      <div class="mobile-updates-bar">
        <div>Updates Available</div>
        ${g()?this.h`<span>${$()}%</span>`:this.h`<button class="action-btn update-all-btn" onclick=${b} disabled=${i().length===0}>Update All</button>`}
      </div>
    `:z()?"":this.h`
      <div class="no-updates-bar">
        No Updates Available
      </div>
    `}
    <div class='body-cydfv983dfff'>
      ${k().map(t=>this.h({key:t})`
        <f-to-signals
          key=${t}
          props=${{from:["updateInfo","updateState"],updateInfo:c()[t],updateState:l()[t],appId:t,publisherProfiles$:P,onUpdate:()=>u(t),render(o){return this.h`<napp-update-card props=${o} />`}}}
        />
      `)}
      ${k().length===0?this.h`<div style=${`padding: 20px; text-align: center; color: ${r.colors.fg2}`}>No apps found</div>`:""}
    </div>
  `});S("napp-update-card",function(){let f=O(localStorage),{appId:v,publisherProfiles$:k,updateInfo$:P,updateState$:c,onUpdate:l}=this.props,g=A(()=>f[`session_appById_${v}_name$`]()),$=d("..."),m=d(null),w=d(null),z=d(null),y=A(()=>{let u=z();return u?k()[u]?.picture:null});U(async()=>{try{let u=await T.create(v);g()||u.getName();let t=u.siteManifest;if(t){let o=new Date(t.created_at*1e3).toISOString().split("T")[0],n=t.id.slice(0,8);$(`${o}-${n}`),t.pubkey&&(w(I(t.pubkey)),z(t.pubkey))}}catch(u){console.error("Error fetching app info",u),$("Unknown")}}),U(({track:u})=>{let t=u(()=>P());if(!t?.event){m(null);return}let o=t.event,n=new Date(o.created_at*1e3).toISOString().split("T")[0],e=o.id.slice(0,8);m(`${n}-${e}`),o.pubkey&&(w(I(o.pubkey)),z(o.pubkey))});let i=c(),h=d(!1),b=d(!1);return U(({track:u})=>{let t=u(()=>c());t?.status==="done"?(h()||(h(!0),setTimeout(()=>h(!1),3600)),b(!1)):t?.status==="error"?(h(!1),b()||(b(!0),setTimeout(()=>b(!1),7e3))):(h(!1),b(!1))}),this.h`
    <style>${`
      .card-8d6gfgwh3wl {
        @media ${E.breakpoints.mobile} {
          margin: 0 10px;
        }
        margin: 0 20px;

        padding: 16px;
        background-color: ${r.colors.bg2};
        border-radius: 16px;
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .icon-wrapper {
        width: 48px;
        height: 48px;
        border-radius: 10px;
        overflow: hidden;
        background-color: ${r.colors.bgAvatar};
        flex-shrink: 0;
      }

      .info {
        flex-grow: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .name-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .name {
        font-weight: 600;
        font-size: 16rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: ${r.colors.fg};
      }

      .name-placeholder {
        height: 16rem;
        width: 150px;
        border-radius: 4px;
        background-color: ${r.colors.bg3};
        margin-bottom: 4px;
      }

      @keyframes pulse {
        50% { opacity: .5; }
      }
      .animate-background {
        animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
      }

      .version-info {
        font-size: 13rem;
        color: ${r.colors.fg2};
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .current-ver {
        opacity: 0.8;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .publisher-avatar {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: ${r.colors.bgAvatar};
        display: inline-block;
        overflow: hidden;
      }

      .next-ver {
        color: ${r.colors.fg2AccentPrimary};
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .update-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 14rem;
        font-weight: 600;
        cursor: pointer;
        border: none;
        background-color: ${r.colors.bgAccentPrimary};
        color: ${r.colors.fgAccent};
        transition: filter 0.2s;
        white-space: nowrap;

        &:hover {
          filter: brightness(1.1);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .progress-circle-container {
        position: relative;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .progress-circle-container.done-fadeout {
        animation: done-fade-out 3.5s forwards;
      }

      @keyframes done-fade-out {
        0%, 85% { opacity: 1; }
        100% { opacity: 0; }
      }

      .progress-circle-svg {
        transform: rotate(-90deg);
        width: 100%;
        height: 100%;
      }

      .progress-circle-bg {
        stroke: ${r.colors.mg2};
      }

      .progress-circle-fg {
        stroke: ${r.colors.bgAccentPrimary};
        transition: stroke-dashoffset 0.3s ease;
      }

      .progress-circle-fg.done {
        stroke: ${r.colors.fgSuccess};
      }

      .progress-circle-fg.error {
        stroke: ${r.colors.fgError};
        animation: error-progress 7s linear forwards;
      }

      @keyframes error-progress {
        from { stroke-dashoffset: 100; }
        to { stroke-dashoffset: 0; }
      }

      .progress-content {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12rem;
        font-weight: 600;
        color: ${r.colors.fg};
      }
    `}</style>
    <div class='card-8d6gfgwh3wl'>
      <div class="icon-wrapper">
        <app-icon props=${{app$:()=>({id:v})}} />
      </div>
      <div class="info">
        <div class="name-row">
          ${w()?this.h`<div class="publisher-avatar"><a-avatar props=${{usePlaceholder:!0,pk$:w,picture$:y}} /></div>`:""}
          ${g()?this.h`<div class="name">${g()}</div>`:this.h`<div class="name-placeholder animate-background"></div>`}
        </div>
        <div class="version-info">
          <span class="current-ver">
            v${$()}
          </span>
          ${m()?this.h`<span class="next-ver"><icon-arrow-narrow-right props=${{size:"14px"}} /> v${m()}</span>`:""}
        </div>
      </div>
      ${i?.status==="updating"||i?.status==="pending"||i?.status==="done"&&h()||i?.status==="error"&&b()?this.h`
          <div class=${`progress-circle-container${i.status==="done"?" done-fadeout":""}`}>
            <svg class="progress-circle-svg" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.9155" fill="none" stroke-width="3" class="progress-circle-bg" />
              <circle cx="18" cy="18" r="15.9155" fill="none" stroke-width="3"
                class=${`progress-circle-fg ${i.status==="done"?"done":""} ${i.status==="error"?"error":""}`}
                stroke-dasharray="100"
                stroke-dashoffset=${i.status==="error"?100:100-(i.status==="pending"?0:i.progress)}
              />
            </svg>
            <div class="progress-content">
              ${i.status==="done"?this.h`<icon-check props=${{size:"20px",style:"color:"+r.colors.fgSuccess}} />`:i.status==="error"?this.h`<icon-exclamation-mark props=${{size:"20px",style:"color:"+r.colors.fgError}} />`:i.status==="pending"?this.h`<icon-hourglass-high props=${{size:"20px",style:"color:"+r.colors.bgAccentSecondary}} />`:Math.round(i.progress)}
            </div>
          </div>
        `:m()?this.h`<button class="update-btn" onclick=${l}>Update</button>`:""}
    </div>
  `});
