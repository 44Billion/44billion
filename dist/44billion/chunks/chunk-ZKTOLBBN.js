import{a as s}from"./chunk-P6IECSNE.js";import{h as o,j as e,p as n}from"./chunk-K2UKPH6Q.js";function r(){let t=s();return e(()=>t.route$().uid<=0?t.route$().url.pathname==="/"&&Object.keys(t.route$().url.searchParams).length===0?t.back():t.replaceState({},"","/"):t.back())}o("icon-chevron-left",function(){let t=n({path$:["M15 6l-6 6l6 6"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...t,...this.props}}
  />`});o("back-btn",function(){let t=r();return this.h`
    <button onclick=${t}>
      <icon-chevron-left props=${{size:"26px"}} />
    </button>
  `});
