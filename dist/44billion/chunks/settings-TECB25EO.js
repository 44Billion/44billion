import"./chunk-ZKTOLBBN.js";import{a as f}from"./chunk-P6IECSNE.js";import{b as u,e as t}from"./chunk-KN6GOQRR.js";import{h as r,j as c,k as d,p as g}from"./chunk-K2UKPH6Q.js";r("toggle-switch",function(){let{checked:s,onChange:l}=this.props;return this.h`
    <style>${`
      .switch {
        position: relative;
        display: inline-block;
        width: 40px;
        height: 24px;
      }
      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: ${t.colors.bg3};
        transition: .4s;
        border-radius: 24px;
      }
      .slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        transition: .4s;
        border-radius: 50%;
      }
      input:checked + .slider {
        background-color: ${t.colors.bgAccentPrimary};
      }
      input:checked + .slider:before {
        transform: translateX(16px);
      }
    `}</style>
    <label class="switch">
      <input type="checkbox" checked=${s} onchange=${o=>l(o.target.checked)} />
      <span class="slider"></span>
    </label>
  `});r("icon-cancel",function(){let s=g({path$:["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0","M18.364 5.636l-12.728 12.728"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...s,...this.props}}
  />`});r("a-settings",function(){let s=u(localStorage),{config_isSingleWindow$:l,config_vaultUrl$:o,session_unread_appUpdateCount$:p}=s,h=f(),i=d(o()),a=d(!1),m=c(e=>{i(e.target.value)}),x=c(()=>{let e=i().trim();e.startsWith("//")?e=`${window.location.protocol}${e}`:e.includes("://")||(e=`${window.location.protocol}//${e}`);try{let n=new URL(e);if(!["http:","https:"].includes(n.protocol)||[n.href,n.href.replace(/\/$/,"")].every(v=>v!==e))throw new Error("Invalid URL");o(e),i(e)}catch{a(!0),setTimeout(()=>a(!1),2e3)}}),b=c(()=>{i(o())});return this.h`
    <style>${`
      a-settings {
        flex-grow: 1;
        max-width: 900px;
        display: flex !important;
        flex-direction: column;
        height: 100%;
        background-color: ${t.colors.bg};
        color: ${t.colors.fg};
      }
      .header {
        height: 55px;
        display: flex;
        align-items: center;
        padding: 0 10px;
        flex-shrink: 0;
        border-bottom: 1px solid ${t.colors.bg2};
      }
      .title {
        flex-grow: 1;
        font-weight: 500;
        font-size: 18rem;
        margin-left: 10px;
      }
      .content {
        padding: 20px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .section {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .section-title {
        font-size: 14rem;
        color: ${t.colors.fgAccent};
        font-weight: 500;
        text-transform: uppercase;
      }
      .item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 15px;
        background-color: ${t.colors.bg2};
        border-radius: 8px;
        cursor: pointer;
      }
      .item-content {
        display: flex;
        flex-direction: column;
      }
      .item-title {
        font-size: 16rem;
        font-weight: 500;
      }
      .item-subtitle {
        font-size: 14rem;
        color: ${t.colors.fg2};
        margin-top: 4px;
      }
      .badge {
        background-color: ${t.colors.bgAccentPrimary};
        color: ${t.colors.fgAccent};
        padding: 4px 8px 2px;
        border-radius: 12px;
        font-size: 12rem;
        font-weight: bold;
      }
      .input-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      input[type="text"] {
        padding: 10px;
        border-radius: 4px;
        border: 1px solid ${t.colors.bg3};
        background-color: ${t.colors.bg};
        color: ${t.colors.fg};
        font-size: 16rem;
      }
    `}</style>

    <div class="header">
      <back-btn />
      <div class="title">Settings</div>
    </div>

    <div class="content">
      <div class="section">
        <div class="section-title">General</div>

        <div class="item" onclick=${()=>h.pushState({},"","/napp-updates")}>
          <div class="item-content">
            <div class="item-title">Napp Updates</div>
            <div class="item-subtitle">Check for updates</div>
          </div>
          ${(p()??0)>0?this.h`<div class="badge">${p()}</div>`:""}
        </div>

        <div class="item">
          <div class="item-content">
            <div class="item-title">Multi-Window Mode</div>
            <div class="item-subtitle">Toggle between single and multi-window mode</div>
          </div>
          <toggle-switch props=${{checked:!l(),onChange:e=>l(!e)}} />
        </div>
      </div>

      <div class="section">
        <div class="section-title">Advanced</div>

        <div class="item" style="cursor: default;">
          <div class="input-group" style="width: 100%;">
            <div class="item-title">Credential Vault URL</div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="text" style=${{flexGrow:1,borderColor:a()?t.colors.fgError:t.colors.bg3}} value=${i()} oninput=${m} />
              ${i()!==o()?this.h`
                  <button onclick=${x} style=${`
                    background: ${t.colors.bgAccentPrimary};
                    color: ${t.colors.fgAccent};
                    border: none;
                    border-radius: 4px;
                    width: 40px;
                    height: 40px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                  `}><icon-check props=${{size:"24px"}} /></button>
                  <button onclick=${b} style=${`
                    background: ${t.colors.bg2};
                    color: ${t.colors.fg};
                    border: none;
                    border-radius: 4px;
                    width: 40px;
                    height: 40px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                  `}><icon-cancel props=${{size:"24px"}} /></button>
                `:""}
            </div>
          </div>
        </div>
      </div>
    </div>
  `});
