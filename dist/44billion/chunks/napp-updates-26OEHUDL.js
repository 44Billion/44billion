import"./chunk-ZKTOLBBN.js";import{a as M}from"./chunk-ST53LDJE.js";import{i as T,n as O}from"./chunk-DF4IVW5S.js";import{e as j}from"./chunk-YCNW34TK.js";import"./chunk-P6IECSNE.js";import{b as I,e as r,f as w}from"./chunk-KN6GOQRR.js";import{h as g,k as d,o as k,p as m,w as E}from"./chunk-K2UKPH6Q.js";g("iconReload",function(){let p=m({path$:["M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747","M20 4v5h-5"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("icon-arrow-narrow-right",function(){let p=m({path$:["M5 12l14 0","M15 16l4 -4","M15 8l4 4"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("iconExclamationMark",function(){let p=m({path$:["M12 19v.01","M12 15v-10"],viewBox$:"2 2 20 20",weight$:"bold"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("icon-hourglass-high",function(){let p=m({path$:["M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z","M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...p,...this.props}}
  />`});g("napp-updates",function(){let p=I(localStorage),{session_unread_appUpdateCount$:S}=p;E(()=>{S(void 0)});let v=k(()=>{let t=p.session_workspaceKeys$()||[],s=new Set;return t.forEach(a=>{let e=p[`session_workspaceByKey_${a}_pinnedAppIds$`]()||[],o=p[`session_workspaceByKey_${a}_unpinnedAppIds$`]()||[];e.forEach(n=>s.add(n)),o.forEach(n=>s.add(n))}),Array.from(s)}),z=d({}),u=d({}),c=d({}),f=d(!1),h=d(0),x=k(()=>Object.keys(u()).length),y=d(0),A=k(()=>y()<v().length),b=d(!1),i=k(()=>{let t=u(),s=c();return Object.keys(t).filter(a=>{let e=s[a]?.status;return e!=="updating"&&e!=="pending"&&e!=="done"})}),$=async()=>{if(b())return;b(!0);let t=v();try{let s=await M.searchForUpdates(t);u(a=>{let e={...a},o=c();return Object.entries(s).forEach(([n,P])=>{let _=o[n]?.status;_==="updating"||_==="pending"||(e[n]=P,o[n]?.status==="error"&&c(B=>{let N={...B};return delete N[n],N}))}),e})}catch(s){console.error("Error checking for updates",s)}finally{y(t.length),b(!1)}};E(async()=>{await $();let t=v(),s=await Promise.all(t.map(e=>O.create(e).catch(()=>null))),a=new Set;if(s.forEach(e=>{e?.bundle?.pubkey&&a.add(e.bundle.pubkey)}),Object.values(u()).forEach(e=>{e.event?.pubkey&&a.add(e.event.pubkey)}),a.size>0)try{let e=await T({kinds:[0],authors:Array.from(a)},{code:"WRITE_RELAYS"}),o={};e.forEach(n=>{try{o[n.pubkey]=JSON.parse(n.content)}catch{}}),z(o)}catch(e){console.error("Bulk fetch failed",e)}});let l=async()=>{if(f())return;let t=i();if(t.length===0)return;f(!0);let s=u(),a=t.map(e=>s[e].event);c(e=>{let o={...e};return t.forEach(n=>{o[n]={status:"pending",progress:0,error:null}}),o});try{for await(let e of M.updateApps(a)){let{appId:o,appProgress:n,error:P,overallProgress:_}=e;h(_),c(B=>({...B,[o]:{status:P?"error":n===100?"done":"updating",progress:n,error:P}}))}u(e=>{let o={...e};return Object.keys(c()).forEach(n=>{c()[n].status==="done"&&delete o[n]}),o})}catch(e){console.error("Update all failed",e)}finally{f(!1),h(0)}},U=async t=>{let s=u()[t];if(!s)return;let a=c()[t]?.status;if(!(a==="updating"||a==="pending")){c(e=>({...e,[t]:{status:"updating",progress:0,error:null}}));try{for await(let e of M.updateApp(s.event))c(o=>({...o,[t]:{status:e.error?"error":"updating",progress:e.appProgress,error:e.error}}));c(e=>({...e,[t]:{status:"done",progress:100,error:null}})),u(e=>{let o={...e};return delete o[t],o})}catch(e){c(o=>({...o,[t]:{status:"error",error:e,progress:0}}))}}};return this.h`
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
        <button class="action-btn" onclick=${$} disabled=${b()}>
          <span class="search-text">${b()?"Searching...":"Search for Updates"}</span>
          <span class=${`search-icon ${b()?"spinning":""}`}><icon-reload props=${{size:"20px"}} /></span>
        </button>
        ${x()>0&&!f()?this.h`<button class="action-btn update-all-btn desktop-update-all" onclick=${l} disabled=${i().length===0}>Update All</button>`:""}
        ${f()?this.h`<div class="desktop-update-all" style=${`font-size:14rem;color:${r.colors.fg2}`}>Updating... ${h()}%</div>`:""}
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
          props=${{from:["updateInfo","updateState"],updateInfo:u()[t],updateState:c()[t],appId:t,publisherProfiles$:z,onUpdate:()=>U(t),render(s){return this.h`<napp-update-card props=${s} />`}}}
        />
      `)}
      ${v().length===0?this.h`<div style=${`padding: 20px; text-align: center; color: ${r.colors.fg2}`}>No apps found</div>`:""}
    </div>
  `});g("napp-update-card",function(){let p=I(localStorage),{appId:S,publisherProfiles$:v,updateInfo$:z,updateState$:u,onUpdate:c}=this.props,f=k(()=>p[`session_appById_${S}_name$`]()),h=d("..."),x=d(null),y=d(null),A=d(null),b=k(()=>{let l=A();return l?v()[l]?.picture:null});E(async()=>{try{let l=await O.create(S);f()||l.getName();let U=l.bundle;if(U){let s=new Date(U.created_at*1e3).toISOString().split("T")[0],a=U.id.slice(0,8);h(`${s}-${a}`)}let t=z();if(t?.event){let s=t.event,a=new Date(s.created_at*1e3).toISOString().split("T")[0],e=s.id.slice(0,8);x(`${a}-${e}`),s.pubkey&&(y(j(s.pubkey)),A(s.pubkey))}else l.bundle?.pubkey&&(y(j(l.bundle.pubkey)),A(l.bundle.pubkey))}catch(l){console.error("Error fetching app info",l),h("Unknown")}});let i=u(),$=d(!1);return E(()=>{u()?.status==="error"?$()||($(!0),setTimeout(()=>{$(!1)},7e3)):$(!1)}),this.h`
    <style>${`
      .card-8d6gfgwh3wl {
        @media ${w.breakpoints.mobile} {
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
        <app-icon props=${{app$:()=>({id:S})}} />
      </div>
      <div class="info">
        <div class="name-row">
          ${y()?this.h`<div class="publisher-avatar"><a-avatar props=${{usePlaceholder:!0,pk$:y,picture$:b}} /></div>`:""}
          ${f()?this.h`<div class="name">${f()}</div>`:this.h`<div class="name-placeholder animate-background"></div>`}
        </div>
        <div class="version-info">
          <span class="current-ver">
            v${h()}
          </span>
          ${x()?this.h`<span class="next-ver"><icon-arrow-narrow-right props=${{size:"14px"}} /> v${x()}</span>`:""}
        </div>
      </div>
      ${i?.status==="updating"||i?.status==="pending"||i?.status==="done"||i?.status==="error"&&$()?this.h`
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
        `:x()?this.h`<button class="update-btn" onclick=${c}>Update</button>`:""}
    </div>
  `});
