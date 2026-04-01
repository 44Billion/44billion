import"./chunk-LV6RTFVQ.js";import{a as B}from"./chunk-VG4M6B23.js";import{j as N,p as T}from"./chunk-4GBGHVLO.js";import{e as I}from"./chunk-4YEM5IRY.js";import"./chunk-NYBCEV4T.js";import{b as O,e as r,f as z}from"./chunk-TBF35Z4Q.js";import{g,j as u,n as U,o as k,v as E}from"./chunk-EOHNSKYH.js";g("iconReload",function(){let l=k({path$:["M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747","M20 4v5h-5"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...l,...this.props}}
  />`});g("icon-arrow-narrow-right",function(){let l=k({path$:["M5 12l14 0","M15 16l4 -4","M15 8l4 4"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...l,...this.props}}
  />`});g("iconExclamationMark",function(){let l=k({path$:["M12 19v.01","M12 15v-10"],viewBox$:"2 2 20 20",weight$:"bold"});return this.h`<a-svg
    props=${{...l,...this.props}}
  />`});g("icon-hourglass-high",function(){let l=k({path$:["M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z","M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...l,...this.props}}
  />`});g("napp-updates",function(){let l=O(localStorage),{session_unread_appUpdateCount$:w}=l;E(()=>{w(void 0)});let S=U(()=>{let t=l.session_workspaceKeys$()||[],o=new Set;return t.forEach(n=>{let e=l[`session_workspaceByKey_${n}_pinnedAppIds$`]()||[],s=l[`session_workspaceByKey_${n}_unpinnedAppIds$`]()||[];e.forEach(a=>o.add(a)),s.forEach(a=>o.add(a))}),Array.from(o)}),P=u({}),c=u({}),p=u({}),h=u(!1),m=u(0),y=U(()=>Object.keys(c()).length),A=u(0),M=U(()=>A()<S().length),v=u(!1),i=U(()=>{let t=c(),o=p();return Object.keys(t).filter(n=>{let e=o[n]?.status;return e!=="updating"&&e!=="pending"&&e!=="done"})}),$=async()=>{if(v())return;v(!0);let t=S();try{let o=await B.searchForUpdates(t);c(n=>{let e={...n},s=p();return Object.entries(o).forEach(([a,d])=>{let _=s[a]?.status;_==="updating"||_==="pending"||(e[a]=d,s[a]?.status==="error"&&p(j=>{let x={...j};return delete x[a],x}))}),e})}catch(o){console.error("Error checking for updates",o)}finally{A(t.length),v(!1)}};E(async()=>{await $();let t=S(),o=await Promise.all(t.map(e=>T.create(e).catch(()=>null))),n=new Set;if(o.forEach(e=>{e?.siteManifest?.pubkey&&n.add(e.siteManifest.pubkey)}),Object.values(c()).forEach(e=>{e.event?.pubkey&&n.add(e.event.pubkey)}),n.size>0)try{let e=await N({kinds:[0],authors:Array.from(n)},{code:"WRITE_RELAYS"}),s={};e.forEach(a=>{try{s[a.pubkey]=JSON.parse(a.content)}catch{}}),P(s)}catch(e){console.error("Bulk fetch failed",e)}});let b=async()=>{if(h())return;let t=i();if(t.length===0)return;h(!0);let o=c(),n=t.map(e=>o[e].event);p(e=>{let s={...e};return t.forEach(a=>{s[a]={status:"pending",progress:0,error:null}}),s});try{for await(let e of B.updateApps(n)){let{appId:s,appProgress:a,error:d,overallProgress:_}=e;m(_);let j=d?"error":a===100?"done":"updating";p(x=>({...x,[s]:{status:j,progress:a,error:d}})),j==="done"&&c(x=>{if(!x[s])return x;let C={...x};return delete C[s],C})}p(e=>{let s={...e},a=!1;return t.forEach(d=>{s[d]&&s[d].status!=="done"&&s[d].status!=="error"&&(s[d]={...s[d],status:"done",progress:100},a=!0)}),a?s:e}),c(e=>{let s={...e},a=!1;return t.forEach(d=>{s[d]&&p()[d]?.status==="done"&&(delete s[d],a=!0)}),a?s:e}),w(Object.keys(c()).length||void 0)}catch(e){console.error("Update all failed",e)}finally{h(!1),m(0)}},f=async t=>{let o=c()[t];if(!o)return;let n=p()[t]?.status;if(!(n==="updating"||n==="pending")){p(e=>({...e,[t]:{status:"updating",progress:0,error:null}}));try{for await(let e of B.updateApp(o.event))p(s=>({...s,[t]:{status:e.error?"error":"updating",progress:e.appProgress,error:e.error}}));p(e=>({...e,[t]:{status:"done",progress:100,error:null}})),c(e=>{let s={...e};return delete s[t],s}),w(Object.keys(c()).length||void 0)}catch(e){p(s=>({...s,[t]:{status:"error",error:e,progress:0}}))}}};return this.h`
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
        @media ${z.breakpoints.mobile} {
          display: none;
        }
      }

      .mobile-updates-bar {
        display: none;
        @media ${z.breakpoints.mobile} {
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
        @media ${z.breakpoints.mobile} {
          display: none;
        }
      }

      .search-icon {
        display: none;
        @media ${z.breakpoints.mobile} {
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
        <button class="action-btn" onclick=${$} disabled=${v()}>
          <span class="search-text">${v()?"Searching...":"Search for Updates"}</span>
          <span class=${`search-icon ${v()?"spinning":""}`}><icon-reload props=${{size:"20px"}} /></span>
        </button>
        ${y()>0&&!h()?this.h`<button class="action-btn update-all-btn desktop-update-all" onclick=${b} disabled=${i().length===0}>Update All</button>`:""}
        ${h()?this.h`<div class="desktop-update-all" style=${`font-size:14rem;color:${r.colors.fg2}`}>Updating... ${m()}%</div>`:""}
      </div>
    </div>
    ${y()>0?this.h`
      <div class="mobile-updates-bar">
        <div>Updates Available</div>
        ${h()?this.h`<span>${m()}%</span>`:this.h`<button class="action-btn update-all-btn" onclick=${b} disabled=${i().length===0}>Update All</button>`}
      </div>
    `:M()?"":this.h`
      <div class="no-updates-bar">
        No Updates Available
      </div>
    `}
    <div class='body-cydfv983dfff'>
      ${S().map(t=>this.h({key:t})`
        <f-to-signals
          key=${t}
          props=${{from:["updateInfo","updateState"],updateInfo:c()[t],updateState:p()[t],appId:t,publisherProfiles$:P,onUpdate:()=>f(t),render(o){return this.h`<napp-update-card props=${o} />`}}}
        />
      `)}
      ${S().length===0?this.h`<div style=${`padding: 20px; text-align: center; color: ${r.colors.fg2}`}>No apps found</div>`:""}
    </div>
  `});g("napp-update-card",function(){let l=O(localStorage),{appId:w,publisherProfiles$:S,updateInfo$:P,updateState$:c,onUpdate:p}=this.props,h=U(()=>l[`session_appById_${w}_name$`]()),m=u("..."),y=u(null),A=u(null),M=u(null),v=U(()=>{let f=M();return f?S()[f]?.picture:null});E(async()=>{try{let f=await T.create(w);h()||f.getName();let t=f.siteManifest;if(t){let o=new Date(t.created_at*1e3).toISOString().split("T")[0],n=t.id.slice(0,8);m(`${o}-${n}`),t.pubkey&&(A(I(t.pubkey)),M(t.pubkey))}}catch(f){console.error("Error fetching app info",f),m("Unknown")}}),E(({track:f})=>{let t=f(()=>P());if(!t?.event){y(null);return}let o=t.event,n=new Date(o.created_at*1e3).toISOString().split("T")[0],e=o.id.slice(0,8);y(`${n}-${e}`),o.pubkey&&(A(I(o.pubkey)),M(o.pubkey))});let i=c(),$=u(!1),b=u(!1);return E(({track:f})=>{let t=f(()=>c());t?.status==="done"?($()||($(!0),setTimeout(()=>$(!1),3600)),b(!1)):t?.status==="error"?($(!1),b()||(b(!0),setTimeout(()=>b(!1),7e3))):($(!1),b(!1))}),this.h`
    <style>${`
      .card-8d6gfgwh3wl {
        @media ${z.breakpoints.mobile} {
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
        <app-icon props=${{app$:()=>({id:w})}} />
      </div>
      <div class="info">
        <div class="name-row">
          ${A()?this.h`<div class="publisher-avatar"><a-avatar props=${{usePlaceholder:!0,pk$:A,picture$:v}} /></div>`:""}
          ${h()?this.h`<div class="name">${h()}</div>`:this.h`<div class="name-placeholder animate-background"></div>`}
        </div>
        <div class="version-info">
          <span class="current-ver">
            v${m()}
          </span>
          ${y()?this.h`<span class="next-ver"><icon-arrow-narrow-right props=${{size:"14px"}} /> v${y()}</span>`:""}
        </div>
      </div>
      ${i?.status==="updating"||i?.status==="pending"||i?.status==="done"&&$()||i?.status==="error"&&b()?this.h`
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
        `:y()?this.h`<button class="update-btn" onclick=${p}>Update</button>`:""}
    </div>
  `});
