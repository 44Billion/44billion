import{h as l,p as c,q as _,t as f,w as $}from"./chunk-K2UKPH6Q.js";function v(t){let{route$:o,onPopState:s,...u}=_("_f_useLocation",()=>{function h({shouldUpdateUrl:e=!0,isInit:n=!1}){let i;if(e){let p=new URL(window.location);p.pathname=p.pathname.replace(new RegExp("(?<!^)\\/+$"),"");let g;i={};for(g in p)i[g]=p[g];i.toString=()=>i.href,delete i.toJSON,i.searchParams=Object.fromEntries(p.searchParams.entries())}else({url:i}=this.route$());let r=history.state?._f_useLocation_uid??(n?0:this?.uidCounter$()??0),a=history.state?"_f_useLocation_uid"in history.state?history.state:{...history.state,_f_useLocation_uid:r}:{previousRoute:null,_f_useLocation_uid:r};return n&&(!history.state||!("_f_useLocation_uid"in history.state))&&history.replaceState(a,""),{uid:r,url:i,state:a}}return{uidCounter$:history.state?._f_useLocation_uid??0,getRoute:h,route$:h({shouldUpdateUrl:!0,isInit:!0}),replaceState(...e){let i=(history.state||{})._f_useLocation_uid??this.uidCounter$(),r={...e[0],_f_useLocation_uid:i};history.replaceState(r,...e.slice(1));let a=e[2]&&location.href!==this.route$().url.href;this.route$(this.getRoute({shouldUpdateUrl:a}))},pushState(...e){let n=new URL(e[2],window.location.origin);if(!e[2]||n.href===this.route$().url.href)return console.warn("Use replaceState when keeping url"),this.replaceState(...e);let r=(history.state?._f_useLocation_uid??0)+1;this.uidCounter$(r);let a={...e[0],_f_useLocation_uid:r};history.pushState(a,...e.slice(1)),this.route$(this.getRoute({shouldUpdateUrl:!0}))},back(){((history.state||{})._f_useLocation_uid||0)<=0||history.back()},forward(){history.forward()},go(e){let i=(history.state||{})._f_useLocation_uid||0;if(e<0){let r=Math.max(e,-i);if(r===0)return;history.go(r)}else history.go(e)},onPopState(){let e=this.getRoute({shouldUpdateUrl:!0});e.uid>this.uidCounter$()&&this.uidCounter$(e.uid),this.route$(e)}}}),d=f("_f_useLocation",()=>({...u,route$(){let h=o(),{params:e,handler:n}=t.find(h.url.pathname)||{};return{...h,params:e,handler:n}},getRouterMatch(h=this.route$().url.pathname){return t.find(h)}}));return y(s),d}function w(t){return t?v(t):f("_f_useLocation")}function y(t){$(({cleanup:o})=>{let s=new AbortController;o(()=>s.abort()),window.addEventListener("popstate",t,{signal:s.signal})})}var S="M0 0h24v24H0V0zm2 2v20h20V2H2z";l("aSvg",function(){let t=c(()=>{let o=this;return{scopeId$:"scope_"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),style$:this.props.style$||this.props.style||"",path$:this.props.path$||this.props.paths$||this.props.path||this.props.paths,_viewBox$:this.props.viewBox$||this.props.viewbox$||this.props.viewBox||this.props.viewbox,viewBox$(){return this._viewBox$()||"0 0 24 24"},hadInitialSvg:!!(this.props.svg$||this.props.svg),shouldKeepDefaultPathStyle$:this.props.shouldKeepDefaultPathStyle$||this.props.shouldKeepDefaultPathStyle||!!(o.props.svg$||o.props.svg),class$:this.props.class$||this.props.class||"",_svgStrings$:[],_svg$(){let s=o.props.svg$?.()||o.props.svg;return typeof s!="string"?s:(this._svgStrings$().length=0,this._svgStrings$().push(s),o.s(this._svgStrings$()))},svg$(){return this._svg$()?this._svg$():o.s`<svg
          class=${this.class$.get()}
          xmlns="http://www.w3.org/2000/svg"
          viewBox=${this.viewBox$.get()}
        >
          ${(Array.isArray(this.path$.get())?this.path$.get():[this.path$.get()||S]).map((s,u)=>o.s({key:u})`<path key=${u} d=${s} />`)}
        </svg>`},color$:this.props.color$||this.props.color||"currentcolor",size$:this.props.size$||this.props.size||"1em",_width$:this.props.width$||this.props.width,_height$:this.props.height$||this.props.height,width$:function(){return this._width$.get()??this.size$.get()},height$:function(){return this._height$.get()??this.size$.get()},weight$:this.props.weight$||this.props.weight||["thin","light","regular","bold","fill","duotone"][1],corner$:this.props.corner$||this.props.corner||["rounded","sharp"][0],mirrored$:(this.props.mirrored$||this.props.mirrored)??!1,flip$:this.props.flip$||this.props.flip||null,scale$:function(){let s;if(this.mirrored$.get()?s="horizontal":s=this.flip$.get(),!s)return"scale(1)";let u=["both","horizontal"].includes(s)?"-1":"1",d=["both","vertical"].includes(s)?"-1":"1";return`scale(${u}, ${d})`},_rotate$:this.props.rotate$||this.props.rotate||"0",rotate$:function(){return`rotate(${this._rotate$.get()})`},_strokeWidth$:this.props.strokeWidth$||this.props.strokeWidth,strokeWidth$:function(){return this._strokeWidth$()??({thin:1,light:1.5,regular:2,bold:3,fill:2,duotone:2}[this.weight$.get()]||0)},fill$:this.props.fill$||this.props.fill||function(){return["fill","duotone"].includes(this.weight$.get())?"currentcolor":"none"},fillOpacity$:this.props.fillOpacity$||this.props.fillOpacity||function(){return this.weight$.get()==="duotone"?".2":"unset"}}});if($(({track:o})=>{o(()=>[t.svg$.get(),t._viewBox$.get()]),t.hadInitialSvg&&t._viewBox$.get()&&this.getElementsByTagName("svg")[0].setAttribute("viewBox",t._viewBox$.get())},{after:"rendering"}),!!t.svg$.get())return this.h`<div id=${t.scopeId$()}>${this.s`
    <style>${`
      /* @scope { */
      #${t.scopeId$()} { display: contents;
        svg {
          /*
            Aligns at middle when no size is set (default 1em)
            if instead parent had set e.g. font-size: 36px;
            You may set it to vertical-align: middle; or other
            value using props.style$
          */
          vertical-align: bottom;
          pointer-events: bounding-box; /* clickable inside holes */
          stroke-width: ${t.strokeWidth$.get()}; /* add unit or it will depend on bbox's unit */
          color: ${t.color$.get()==="currentColor"?"currentcolor":t.color$.get()};
          transform: ${t.scale$.get()}
                     ${t.rotate$.get()};
          width: ${t.width$()};
          height: ${t.height$()};
        }
        ${t.shouldKeepDefaultPathStyle$()?"":`path {
          fill: ${t.fill$.get()};
          fill-opacity: ${t.fillOpacity$.get()};
          stroke: currentcolor;
          ${t.corner$.get()==="sharp"?"":`
            stroke-linecap: round;
            stroke-linejoin: round;
          `}
        }`}
        ${t.style$.get()}
      }
    `}</style>${t.svg$.get()}
  `}</div>`});l("icon-check",function(){let t=c({path$:["M5 12l5 5l10 -10"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...t,...this.props}}
  />`});export{w as a};
