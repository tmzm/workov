"""Generates chat-mockup-<theme>.html (Andon, Cyberpunk, Tmzm) from chat-base.html using the dashboard's real theme tokens."""
import re, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'chat-base.html'), encoding='utf-8').read()

i = src.index(':root{'); j = src.index('*{box-sizing')
mapping = """:root{--sans:var(--font-ui);--mono:var(--font-mono);
  --surface:var(--surface-1);--raised:var(--surface-2);--line2:color-mix(in srgb,var(--line-strong) 40%,var(--line));
  --dim:var(--text-2);--faint:var(--text-3);--on-accent:var(--accent-text);
  --ok:var(--lamp-run);--bad:var(--lamp-stop);--info:var(--lamp-info);--code:var(--readout-bg);
  --accent-soft:color-mix(in srgb,var(--accent) 14%,transparent);
  --add:color-mix(in srgb,var(--lamp-run) 15%,transparent);--del:color-mix(in srgb,var(--lamp-stop) 15%,transparent);
  --shadow:var(--shadow-float);--rk:1;--rpill:999px}
"""
src = src[:i] + mapping + src[j:]
src = re.sub(r'border-radius:(\d+)px', lambda m: 'border-radius:calc(%spx*var(--rk))' % m.group(1), src)
src = src.replace('border-radius:999px', 'border-radius:var(--rpill)')
src = src.replace('<html lang="en" data-mode="dark">', '<html lang="en" data-mode="dark" data-theme="@T@">')

T = {}
T['andon'] = ('Andon', """
:root[data-theme=andon][data-mode=dark]{color-scheme:dark;--bg:#121314;--surface-1:#1a1b1d;--surface-2:#222326;--surface-3:#2b2d30;--line:#34363a;--line-strong:#70737a;--text:#ecebe7;--text-2:#bdbbb4;--text-3:#9a988f;--lamp-run:#5bd38a;--lamp-stop:#ff6b61;--lamp-info:#6cb1ff;--readout-bg:#17191c;--accent:#6cb1ff;--accent-text:#0b1624;--shadow-float:0 12px 32px -8px rgb(0 0 0/.6);--font-ui:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-mono:ui-monospace,"Cascadia Mono","JetBrains Mono",Consolas,monospace}
:root[data-theme=andon][data-mode=light]{color-scheme:light;--bg:#eef0ee;--surface-1:#fff;--surface-2:#f6f7f5;--surface-3:#e9ebe8;--line:#dcdedb;--line-strong:#8d908a;--text:#17181a;--text-2:#3f4044;--text-3:#5d5e62;--lamp-run:#1d7f45;--lamp-stop:#c0362c;--lamp-info:#1f62b8;--readout-bg:#f2f3f1;--accent:#1f62b8;--accent-text:#fff;--shadow-float:0 12px 32px -10px rgb(23 24 26/.2);--font-ui:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-mono:ui-monospace,"Cascadia Mono",Consolas,monospace}
""", "")

T['cyberpunk'] = ('Cyberpunk', """
:root[data-theme=cyberpunk][data-mode=dark]{color-scheme:dark;--bg:#0b0c16;--surface-1:#11131f;--surface-2:#171a2a;--surface-3:#1f2336;--line:#2a2f4a;--line-strong:#6a76a8;--text:#e2edf9;--text-2:#b4c2e0;--text-3:#8f9dc6;--lamp-run:#2bff88;--lamp-stop:#ff5577;--lamp-info:#00e5ff;--readout-bg:#0d0f1a;--accent:#ff2bd6;--accent-text:#0b0c16;--focus:#fcee0a;--scan:repeating-linear-gradient(to bottom,rgb(94 234 255/.05) 0 1px,transparent 1px 4px);--glow:0 0 10px rgb(0 229 255/.35);--shadow-float:0 16px 40px -12px rgb(0 0 0/.75),0 0 0 1px rgb(0 229 255/.22),0 0 28px -8px rgb(0 229 255/.35)}
:root[data-theme=cyberpunk][data-mode=light]{color-scheme:light;--bg:#eef0fb;--surface-1:#fff;--surface-2:#f4f5fe;--surface-3:#e6e9fa;--line:#cfd3ee;--line-strong:#6a76a8;--text:#151a33;--text-2:#2d3560;--text-3:#4b5486;--lamp-run:#0a8a4a;--lamp-stop:#c4153f;--lamp-info:#006e8a;--readout-bg:#f7f8ff;--accent:#c4009f;--accent-text:#fff;--focus:#5a2bd9;--scan:repeating-linear-gradient(to bottom,rgb(106 118 168/.07) 0 1px,transparent 1px 4px);--glow:none;--shadow-float:0 16px 40px -14px rgb(21 26 51/.35),0 0 0 1px rgb(196 0 159/.22)}
:root[data-theme=cyberpunk]{--font-ui:"Bahnschrift","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;--font-mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;--rk:0;--rpill:0px}
""", """
:root[data-theme=cyberpunk] body{background-image:var(--scan)}
:root[data-theme=cyberpunk] .brand,:root[data-theme=cyberpunk] .side h4,:root[data-theme=cyberpunk] .todo h5,:root[data-theme=cyberpunk] .menu .sec{font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em}
:root[data-theme=cyberpunk] .tool,:root[data-theme=cyberpunk] .todo,:root[data-theme=cyberpunk] .user{clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))}
:root[data-theme=cyberpunk] .btn,:root[data-theme=cyberpunk] .pill,:root[data-theme=cyberpunk] .send{clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}
:root[data-theme=cyberpunk] .perm{box-shadow:var(--shadow-float)}
:root[data-theme=cyberpunk] .caret{box-shadow:0 0 10px var(--accent)}
:root[data-theme=cyberpunk] .asst .badge,:root[data-theme=cyberpunk] .logo{box-shadow:0 0 12px -2px var(--accent)}
:root[data-theme=cyberpunk] .btn.primary,:root[data-theme=cyberpunk] .send{box-shadow:0 0 14px -3px var(--accent)}
:root[data-theme=cyberpunk] :focus-visible{outline-color:var(--focus);box-shadow:0 0 12px 1px var(--focus)}
:root[data-theme=cyberpunk] .tool .verb{text-shadow:var(--glow)}
""")

T['tmzm'] = ('Tmzm', """
:root[data-theme=tmzm][data-mode=dark]{color-scheme:dark;--bg:#0f0e0b;--surface-1:#1a1813;--surface-2:#25221b;--surface-3:#2e2a22;--line:#3a352b;--line-strong:#6b6456;--text:#ece9e2;--text-2:#cfcac0;--text-3:#a29c90;--lamp-run:#6fcf7f;--lamp-stop:#f0a08f;--lamp-info:#c9a14a;--readout-bg:#14120e;--accent:#c9a14a;--accent-text:#0f0e0b;--focus:#d2ab57;--shadow-float:0 12px 32px -8px rgb(0 0 0/.6),0 0 0 1px rgb(201 161 74/.18)}
:root[data-theme=tmzm][data-mode=light]{color-scheme:light;--bg:#f4f3ef;--surface-1:#fbfaf7;--surface-2:#efece4;--surface-3:#e6e1d4;--line:#dcd6c8;--line-strong:#8f8672;--text:#16140f;--text-2:#3b372e;--text-3:#625c50;--lamp-run:#2f8a44;--lamp-stop:#b3412c;--lamp-info:#7d5f1c;--readout-bg:#f3f0e7;--accent:#c9a14a;--accent-text:#0f0e0b;--focus:#7d5f1c;--shadow-float:0 12px 32px -10px rgb(22 20 15/.28),0 2px 6px rgb(22 20 15/.12)}
:root[data-theme=tmzm]{--font-ui:"Geist",system-ui,"Segoe UI",sans-serif;--font-mono:"JetBrains Mono","Cascadia Mono",Consolas,monospace;--display:"Big Shoulders Display","Oswald","Bahnschrift","Arial Narrow",sans-serif;--rk:.17;--rpill:2px;--ease:cubic-bezier(.16,1,.3,1)}
""", """
:root[data-theme=tmzm] .brand,:root[data-theme=tmzm] .side h4,:root[data-theme=tmzm] .todo h5{font-family:var(--display);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
:root[data-theme=tmzm] .side h4::before,:root[data-theme=tmzm] .todo h5 span:first-child::before{content:"{ ";color:var(--accent);font-family:var(--mono)}
:root[data-theme=tmzm] .side h4::after,:root[data-theme=tmzm] .todo h5 span:first-child::after{content:" }";color:var(--accent);font-family:var(--mono)}
:root[data-theme=tmzm] .brand{font-size:17px}
:root[data-theme=tmzm] .tool,:root[data-theme=tmzm] .btn,:root[data-theme=tmzm] .perm{transition:transform .45s var(--ease),border-color .3s var(--ease),box-shadow .45s var(--ease)}
:root[data-theme=tmzm] .tool:hover{transform:translateY(-2px);border-color:var(--accent)}
:root[data-theme=tmzm] .btn.primary:hover{box-shadow:0 0 0 1px var(--accent),0 10px 24px -12px var(--accent)}
:root[data-theme=tmzm] .col>*{animation-duration:.7s!important;animation-timing-function:var(--ease)!important}
""")

for k, (name, tokens, extra) in T.items():
    out = src.replace('@T@', k).replace('<title>Workeve Chat mockup</title>', '<title>Workeve Chat mockup: %s</title>' % name)
    out = out.replace('</style>', tokens + extra + '</style>', 1)
    out = out.replace('<div class="brand"><span class="logo">E</span>Workeve Chat</div>',
                      '<div class="brand"><span class="logo">E</span>Workeve Chat <span style="font-weight:400;color:var(--faint);font-size:12px;margin-left:4px">%s</span></div>' % name)
    open(os.path.join(HERE, 'chat-mockup-%s.html' % k), 'w', encoding='utf-8', newline='\n').write(out)
print('generated', ', '.join(T))

# ---- the real chat: one stylesheet with all three themes, and chat.html with the shared icon sprite ----
base = open(os.path.join(HERE, 'chat-base.html'), encoding='utf-8').read()
css = re.search(r'<style>(.*?)</style>', src, re.S).group(1)  # mapped base styles
css = css.replace(':root[data-theme="@T@"]', '')
themes = ''.join(tokens + extra for (_n, tokens, extra) in T.values())
sprite = re.search(r'(<svg width="0".*?</svg>)', base, re.S).group(1)
open(os.path.join(HERE, '..', 'chat.css'), 'w', encoding='utf-8', newline='\n').write(css + themes + open(os.path.join(HERE, 'chat-extra.css'), encoding='utf-8').read())
tpl = open(os.path.join(HERE, 'chat.template.html'), encoding='utf-8').read().replace('<!--SPRITE-->', sprite)
open(os.path.join(HERE, '..', 'chat.html'), 'w', encoding='utf-8', newline='\n').write(tpl)
print('chat.css and chat.html written')
