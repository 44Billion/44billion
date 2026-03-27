import"./chunk-LV6RTFVQ.js";import{a as _}from"./chunk-HVK2I4BU.js";import{f as T,l as O}from"./chunk-CUCTXUW3.js";import{e as j}from"./chunk-4YEM5IRY.js";import"./chunk-NYBCEV4T.js";import{b as I,e as s,f as w}from"./chunk-TBF35Z4Q.js";import{g,j as d,n as k,o as m,v as M}from"./chunk-EOHNSKYH.js";g("iconReload",function(){let p=m({path$:["M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747","M20 4v5h-5"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("icon-arrow-narrow-right",function(){let p=m({path$:["M5 12l14 0","M15 16l4 -4","M15 8l4 4"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("iconExclamationMark",function(){let p=m({path$:["M12 19v.01","M12 15v-10"],viewBox$:"2 2 20 20",weight$:"bold"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("icon-hourglass-high",function(){let p=m({path$:["M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z","M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("napp-updates",function(){let p=I(localStorage),{session_unread_appUpdateCount$:S}=p;M(()=>{S(void 0)});let v=k(()=>{let t=p.session_workspaceKeys$()||[],r=new Set;return t.forEach(a=>{let e=p[`session_workspaceByKey_${a}_pinnedAppIds$`]()||[],o=p[`session_workspaceByKey_${a}_unpinnedAppIds$`]()||[];e.forEach(n=>r.add(n)),o.forEach(n=>r.add(n))}),Array.from(r)}),E=d({}),u=d({}),c=d({}),f=d(!1),h=d(0),x=k(()=>Object.keys(u()).length),y=d(0),A=k(()=>y()<v().length),$=d(!1),i=k(()=>{let t=u(),r=c();return Object.keys(t).filter(a=>{let e=r[a]?.status;return e!=="updating"&&e!=="pending"&&e!=="done"})}),b=async()=>{if($())return;$(!0);let t=v();try{let r=await _.searchForUpdates(t);u(a=>{let e={...a},o=c();return Object.entries(r).forEach(([n,z])=>{let P=o[n]?.status;P==="updating"||P==="pending"||(e[n]=z,o[n]?.status==="error"&&c(B=>{let N={...B};return delete N[n],N}))}),e})}catch(r){console.error("Error checking for updates",r)}finally{y(t.length),$(!1)}};M(async()=>{await b();let t=v(),r=await Promise.all(t.map(e=>O.create(e).catch(()=>null))),a=new Set;if(r.forEach(e=>{e?.siteManifest?.pubkey&&a.add(e.siteManifest.pubkey)}),Object.values(u()).forEach(e=>{e.event?.pubkey&&a.add(e.event.pubkey)}),a.size>0)try{let e=await T({kinds:[0],authors:Array.from(a)},{code:"WRITE_RELAYS"}),o={};e.forEach(n=>{try{o[n.pubkey]=JSON.parse(n.content)}catch{}}),E(o)}catch(e){console.error("Bulk fetch failed",e)}});let l=async()=>{if(f())return;let t=i();if(t.length===0)return;f(!0);let r=u(),a=t.map(e=>r[e].event);c(e=>{let o={...e};return t.forEach(n=>{o[n]={status:"pending",progress:0,error:null}}),o});try{for await(let e of _.updateApps(a)){let{appId:o,appProgress:n,error:z,overallProgress:P}=e;h(P),c(B=>({...B,[o]:{status:z?"error":n===100?"done":"updating",progress:n,error:z}}))}u(e=>{let o={...e};return Object.keys(c()).forEach(n=>{c()[n].status==="done"&&delete o[n]}),o})}catch(e){console.error("Update all failed",e)}finally{f(!1),h(0)}},U=async t=>{let r=u()[t];if(!r)return;let a=c()[t]?.status;if(!(a==="updating"||a==="pending")){c(e=>({...e,[t]:{status:"updating",progress:0,error:null}}));try{for await(let e of _.updateApp(r.event))c(o=>({...o,[t]:{status:e.error?"error":"updating",progress:e.appProgress,error:e.error}}));c(e=>({...e,[t]:{status:"done",progress:100,error:null}})),u(e=>{let o={...e};return delete o[t],o})}catch(e){c(o=>({...o,[t]:{status:"error",error:e,progress:0}}))}}};return this.h`
    <style>${`
      napp-updates {
        flex-grow: 1; /* use max width available */
        max-width: 900px;
        display: flex !important;
        flex-direction: column;
        height: 100%;
      }

      .header-1kuhvcxd8b {
        background-color: ${s.colors.bg};
        color: ${s.colors.fg};
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
        background-color: ${s.colors.bg2};
        color: ${s.colors.fg};
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background-color: ${s.colors.bg3};
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .update-all-btn {
        background-color: ${s.colors.bgAccentPrimary};
        color: ${s.colors.fgAccent};

        &:hover {
          filter: brightness(1.1);
          background-color: ${s.colors.bgAccentPrimary};
        }
      }

      .desktop-update-all {
        @media ${w.breakpoints.mobile} {
          display: none;
        }
      }

      .mobile-updates-bar {
        display: none;
        @media ${w.breakpoints.mobile} {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 20px;
          font-weight: 500;
          color: ${s.colors.fg};
        }
      }

      .no-updates-bar {
        display: flex;
        padding: 10px 20px;
        font-style: italic;
        color: ${s.colors.fg2};
      }

      .search-text {
        @media ${w.breakpoints.mobile} {
          display: none;
        }
      }

      .search-icon {
        display: none;
        @media ${w.breakpoints.mobile} {
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
        <button class="action-btn" onclick=${b} disabled=${$()}>
          <span class="search-text">${$()?"Searching...":"Search for Updates"}</span>
          <span class=${`search-icon ${$()?"spinning":""}`}><icon-reload props=${{size:"20px"}} /></span>
        </button>
        ${x()>0&&!f()?this.h`<button class="action-btn update-all-btn desktop-update-all" onclick=${l} disabled=${i().length===0}>Update All</button>`:""}
        ${f()?this.h`<div class="desktop-update-all" style=${`font-size:14rem;color:${s.colors.fg2}`}>Updating... ${h()}%</div>`:""}
      </div>
    </div>
    ${x()>0?this.h`
      <div class="mobile-updates-bar">
        <div>Updates Available</div>
        ${f()?this.h`<span>${h()}%</span>`:this.h`<button class="action-btn update-all-btn" onclick=${l} disabled=${i().length===0}>Update All</button>`}
      </div>
    `:A()?"":this.h`
      <div class="no-updates-bar">
        No Updates Available
      </div>
    `}
    <div class='body-cydfv983dfff'>
      ${v().map(t=>this.h({key:t})`
        <f-to-signals
          key=${t}
          props=${{from:["updateInfo","updateState"],updateInfo:u()[t],updateState:c()[t],appId:t,publisherProfiles$:E,onUpdate:()=>U(t),render(r){return this.h`<napp-update-card props=${r} />`}}}
        />
      `)}
      ${v().length===0?this.h`<div style=${`padding: 20px; text-align: center; color: ${s.colors.fg2}`}>No apps found</div>`:""}
    </div>
  `});g("napp-update-card",function(){let p=I(localStorage),{appId:S,publisherProfiles$:v,updateInfo$:E,updateState$:u,onUpdate:c}=this.props,f=k(()=>p[`session_appById_${S}_name$`]()),h=d("..."),x=d(null),y=d(null),A=d(null),$=k(()=>{let l=A();return l?v()[l]?.picture:null});M(async()=>{try{let l=await O.create(S);f()||l.getName();let U=l.siteManifest;if(U){let r=new Date(U.created_at*1e3).toISOString().split("T")[0],a=U.id.slice(0,8);h(`${r}-${a}`)}let t=E();if(t?.event){let r=t.event,a=new Date(r.created_at*1e3).toISOString().split("T")[0],e=r.id.slice(0,8);x(`${a}-${e}`),r.pubkey&&(y(j(r.pubkey)),A(r.pubkey))}else l.siteManifest?.pubkey&&(y(j(l.siteManifest.pubkey)),A(l.siteManifest.pubkey))}catch(l){console.error("Error fetching app info",l),h("Unknown")}});let i=u(),b=d(!1);return M(()=>{u()?.status==="error"?b()||(b(!0),setTimeout(()=>{b(!1)},7e3)):b(!1)}),this.h`
    <style>${`
      .card-8d6gfgwh3wl {
        @media ${w.breakpoints.mobile} {
          margin: 0 10px;
        }
        margin: 0 20px;

        padding: 16px;
        background-color: ${s.colors.bg2};
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
        background-color: ${s.colors.bgAvatar};
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
        color: ${s.colors.fg};
      }

      .name-placeholder {
        height: 16rem;
        width: 150px;
        border-radius: 4px;
        background-color: ${s.colors.bg3};
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
        color: ${s.colors.fg2};
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
        background-color: ${s.colors.bgAvatar};
        display: inline-block;
        overflow: hidden;
      }

      .next-ver {
        color: ${s.colors.fg2AccentPrimary};
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
        background-color: ${s.colors.bgAccentPrimary};
        color: ${s.colors.fgAccent};
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
        stroke: ${s.colors.mg2};
      }

      .progress-circle-fg {
        stroke: ${s.colors.bgAccentPrimary};
        transition: stroke-dashoffset 0.3s ease;
      }

      .progress-circle-fg.done {
        stroke: ${s.colors.fgSuccess};
      }

      .progress-circle-fg.error {
        stroke: ${s.colors.fgError};
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
        color: ${s.colors.fg};
      }
    `}</style>
    <div class='card-8d6gfgwh3wl'>
      <div class="icon-wrapper">
        <app-icon props=${{app$:()=>({id:S})}} />
      </div>
      <div class="info">
        <div class="name-row">
          ${y()?this.h`<div class="publisher-avatar"><a-avatar props=${{usePlaceholder:!0,pk$:y,picture$:$}} /></div>`:""}
          ${f()?this.h`<div class="name">${f()}</div>`:this.h`<div class="name-placeholder animate-background"></div>`}
        </div>
        <div class="version-info">
          <span class="current-ver">
            v${h()}
          </span>
          ${x()?this.h`<span class="next-ver"><icon-arrow-narrow-right props=${{size:"14px"}} /> v${x()}</span>`:""}
        </div>
      </div>
      ${i?.status==="updating"||i?.status==="pending"||i?.status==="done"||i?.status==="error"&&b()?this.h`
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
              ${i.status==="done"?this.h`<icon-check props=${{size:"20px",style:"color:"+s.colors.fgSuccess}} />`:i.status==="error"?this.h`<icon-exclamation-mark props=${{size:"20px",style:"color:"+s.colors.fgError}} />`:i.status==="pending"?this.h`<icon-hourglass-high props=${{size:"20px",style:"color:"+s.colors.bgAccentSecondary}} />`:Math.round(i.progress)}
            </div>
          </div>
        `:x()?this.h`<button class="update-btn" onclick=${c}>Update</button>`:""}
    </div>
  `});
