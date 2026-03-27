import"./chunk-LV6RTFVQ.js";import{a as _}from"./chunk-HVK2I4BU.js";import{f as T,l as I}from"./chunk-CUCTXUW3.js";import{e as B}from"./chunk-4YEM5IRY.js";import"./chunk-NYBCEV4T.js";import{b as O,e as r,f as U}from"./chunk-TBF35Z4Q.js";import{g as f,j as u,n as S,o as y,v as A}from"./chunk-EOHNSKYH.js";f("iconReload",function(){let p=y({path$:["M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747","M20 4v5h-5"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});f("icon-arrow-narrow-right",function(){let p=y({path$:["M5 12l14 0","M15 16l4 -4","M15 8l4 4"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});f("iconExclamationMark",function(){let p=y({path$:["M12 19v.01","M12 15v-10"],viewBox$:"2 2 20 20",weight$:"bold"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});f("icon-hourglass-high",function(){let p=y({path$:["M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z","M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});f("napp-updates",function(){let p=O(localStorage),{session_unread_appUpdateCount$:x}=p;A(()=>{x(void 0)});let k=S(()=>{let t=p.session_workspaceKeys$()||[],a=new Set;return t.forEach(n=>{let e=p[`session_workspaceByKey_${n}_pinnedAppIds$`]()||[],s=p[`session_workspaceByKey_${n}_unpinnedAppIds$`]()||[];e.forEach(o=>a.add(o)),s.forEach(o=>a.add(o))}),Array.from(a)}),z=u({}),l=u({}),c=u({}),h=u(!1),b=u(0),$=S(()=>Object.keys(l()).length),w=u(0),E=S(()=>w()<k().length),m=u(!1),i=S(()=>{let t=l(),a=c();return Object.keys(t).filter(n=>{let e=a[n]?.status;return e!=="updating"&&e!=="pending"&&e!=="done"})}),v=async()=>{if(m())return;m(!0);let t=k();try{let a=await _.searchForUpdates(t);l(n=>{let e={...n},s=c();return Object.entries(a).forEach(([o,M])=>{let P=s[o]?.status;P==="updating"||P==="pending"||(e[o]=M,s[o]?.status==="error"&&c(j=>{let N={...j};return delete N[o],N}))}),e})}catch(a){console.error("Error checking for updates",a)}finally{w(t.length),m(!1)}};A(async()=>{await v();let t=k(),a=await Promise.all(t.map(e=>I.create(e).catch(()=>null))),n=new Set;if(a.forEach(e=>{e?.siteManifest?.pubkey&&n.add(e.siteManifest.pubkey)}),Object.values(l()).forEach(e=>{e.event?.pubkey&&n.add(e.event.pubkey)}),n.size>0)try{let e=await T({kinds:[0],authors:Array.from(n)},{code:"WRITE_RELAYS"}),s={};e.forEach(o=>{try{s[o.pubkey]=JSON.parse(o.content)}catch{}}),z(s)}catch(e){console.error("Bulk fetch failed",e)}});let d=async()=>{if(h())return;let t=i();if(t.length===0)return;h(!0);let a=l(),n=t.map(e=>a[e].event);c(e=>{let s={...e};return t.forEach(o=>{s[o]={status:"pending",progress:0,error:null}}),s});try{for await(let e of _.updateApps(n)){let{appId:s,appProgress:o,error:M,overallProgress:P}=e;b(P),c(j=>({...j,[s]:{status:M?"error":o===100?"done":"updating",progress:o,error:M}}))}c(e=>{let s={...e};return t.forEach(o=>{s[o]&&s[o].status!=="error"&&(s[o]={...s[o],status:"done",progress:100})}),s}),l(e=>{let s={...e};return Object.keys(c()).forEach(o=>{c()[o].status==="done"&&delete s[o]}),s}),x(Object.keys(l()).length||void 0)}catch(e){console.error("Update all failed",e)}finally{h(!1),b(0)}},g=async t=>{let a=l()[t];if(!a)return;let n=c()[t]?.status;if(!(n==="updating"||n==="pending")){c(e=>({...e,[t]:{status:"updating",progress:0,error:null}}));try{for await(let e of _.updateApp(a.event))c(s=>({...s,[t]:{status:e.error?"error":"updating",progress:e.appProgress,error:e.error}}));c(e=>({...e,[t]:{status:"done",progress:100,error:null}})),l(e=>{let s={...e};return delete s[t],s}),x(Object.keys(l()).length||void 0)}catch(e){c(s=>({...s,[t]:{status:"error",error:e,progress:0}}))}}};return this.h`
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
        @media ${U.breakpoints.mobile} {
          display: none;
        }
      }

      .mobile-updates-bar {
        display: none;
        @media ${U.breakpoints.mobile} {
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
        @media ${U.breakpoints.mobile} {
          display: none;
        }
      }

      .search-icon {
        display: none;
        @media ${U.breakpoints.mobile} {
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
      <div class='title-gd7a98'>Napp Updates</div>
      <div class="actions-wrapper">
        <button class="action-btn" onclick=${v} disabled=${m()}>
          <span class="search-text">${m()?"Searching...":"Search for Updates"}</span>
          <span class=${`search-icon ${m()?"spinning":""}`}><icon-reload props=${{size:"20px"}} /></span>
        </button>
        ${$()>0&&!h()?this.h`<button class="action-btn update-all-btn desktop-update-all" onclick=${d} disabled=${i().length===0}>Update All</button>`:""}
        ${h()?this.h`<div class="desktop-update-all" style=${`font-size:14rem;color:${r.colors.fg2}`}>Updating... ${b()}%</div>`:""}
      </div>
    </div>
    ${$()>0?this.h`
      <div class="mobile-updates-bar">
        <div>Updates Available</div>
        ${h()?this.h`<span>${b()}%</span>`:this.h`<button class="action-btn update-all-btn" onclick=${d} disabled=${i().length===0}>Update All</button>`}
      </div>
    `:E()?"":this.h`
      <div class="no-updates-bar">
        No Updates Available
      </div>
    `}
    <div class='body-cydfv983dfff'>
      ${k().map(t=>this.h({key:t})`
        <f-to-signals
          key=${t}
          props=${{from:["updateInfo","updateState"],updateInfo:l()[t],updateState:c()[t],appId:t,publisherProfiles$:z,onUpdate:()=>g(t),render(a){return this.h`<napp-update-card props=${a} />`}}}
        />
      `)}
      ${k().length===0?this.h`<div style=${`padding: 20px; text-align: center; color: ${r.colors.fg2}`}>No apps found</div>`:""}
    </div>
  `});f("napp-update-card",function(){let p=O(localStorage),{appId:x,publisherProfiles$:k,updateInfo$:z,updateState$:l,onUpdate:c}=this.props,h=S(()=>p[`session_appById_${x}_name$`]()),b=u("..."),$=u(null),w=u(null),E=u(null),m=S(()=>{let d=E();return d?k()[d]?.picture:null});A(async()=>{try{let d=await I.create(x);h()||d.getName();let g=d.siteManifest;if(g){let t=new Date(g.created_at*1e3).toISOString().split("T")[0],a=g.id.slice(0,8);b(`${t}-${a}`),g.pubkey&&(w(B(g.pubkey)),E(g.pubkey))}}catch(d){console.error("Error fetching app info",d),b("Unknown")}}),A(({track:d})=>{let g=d(()=>z());if(!g?.event){$(null);return}let t=g.event,a=new Date(t.created_at*1e3).toISOString().split("T")[0],n=t.id.slice(0,8);$(`${a}-${n}`),t.pubkey&&(w(B(t.pubkey)),E(t.pubkey))});let i=l(),v=u(!1);return A(()=>{l()?.status==="error"?v()||(v(!0),setTimeout(()=>{v(!1)},7e3)):v(!1)}),this.h`
    <style>${`
      .card-8d6gfgwh3wl {
        @media ${U.breakpoints.mobile} {
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
        <app-icon props=${{app$:()=>({id:x})}} />
      </div>
      <div class="info">
        <div class="name-row">
          ${w()?this.h`<div class="publisher-avatar"><a-avatar props=${{usePlaceholder:!0,pk$:w,picture$:m}} /></div>`:""}
          ${h()?this.h`<div class="name">${h()}</div>`:this.h`<div class="name-placeholder animate-background"></div>`}
        </div>
        <div class="version-info">
          <span class="current-ver">
            v${b()}
          </span>
          ${$()?this.h`<span class="next-ver"><icon-arrow-narrow-right props=${{size:"14px"}} /> v${$()}</span>`:""}
        </div>
      </div>
      ${i?.status==="updating"||i?.status==="pending"||i?.status==="done"||i?.status==="error"&&v()?this.h`
          <div class="progress-circle-container">
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
        `:$()?this.h`<button class="update-btn" onclick=${c}>Update</button>`:""}
    </div>
  `});
