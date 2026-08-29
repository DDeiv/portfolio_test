const Engine = Matter.Engine,
    Bodies = Matter.Bodies,
    World = Matter.World,
    Body = Matter.Body,
    Sleeping = Matter.Sleeping;

const isChrome = navigator.userAgent.indexOf('Chrome') > -1;
const isMobileView = () => window.innerWidth <= 768;

// Respect the user's OS-level "reduce motion" preference: the text is still
// rebuilt word by word (same layout), but nothing falls and no physics runs.
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Sleeping is desktop-only: it lets settled bodies rest cheaply and wake on
// window resize. On phones it proved unreliable (words dozing off mid-air),
// so there the freeze is handled manually in the render loop instead.
const engine = Engine.create({
    enableSleeping: window.innerWidth > 768,
    // Defaults are 6/4. Words are thin boxes stacking into a deep pile, which
    // is the hardest case for a sequential impulse solver: contact error at
    // the bottom propagates up the stack. More position iterations buy
    // noticeably firmer resting contacts for a few tenths of a ms per step.
    positionIterations: 10,
    velocityIterations: 8,
    timing: {
        timeScale: 0.85,
        delta: 1000 / 60
    }
});
const setGravity = () => {
    engine.world.gravity.x = 0;
    engine.world.gravity.y = isChrome ?
        (isMobileView() ? 1.4 : 1.1) :
        (isMobileView() ? 2.0 : 1.3);
};
setGravity();

// ── Boundaries ──────────────────────────────────────────────────────────────
// Desktop: ground + walls + ceiling, so words stay in the viewport and react
// to window resizing. Mobile: ground only, like the original version.
let bounds = [];

const createBounds = () => {
    const t = 60;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // ground (same position as before: top edge at h - 40)
    const list = [
        Bodies.rectangle(w / 2, h - 10, w, t, {
            isStatic: true,
            friction: 0.85,
            restitution: 0.15
        })
    ];

    // Walls and ceiling on desktop only, where they make resize reactions
    // work. On mobile they made the pile stack up and jiggle forever,
    // which killed performance — original ground-only setup restored.
    if (!isMobileView()) {
        list.push(
            Bodies.rectangle(-t / 2, h / 2, t, h * 4, { isStatic: true }),
            Bodies.rectangle(w + t / 2, h / 2, t, h * 4, { isStatic: true }),
            Bodies.rectangle(w / 2, -t / 2, w * 4, t, { isStatic: true })
        );
    }

    return list;
};

bounds = createBounds();
World.add(engine.world, bounds);

const links = {
    'Politecnico di Milano': 'https://www.design.polimi.it/',
    'Davide': 'mailto:davidebocchi@icloud.com',
    'Audience Zero': 'https://www.audiencezero.com',
    'Corsedimoto.com': 'https://www.corsedimoto.com/',
    'contact': 'mailto:davidebocchi@icloud.com',
    'here': 'works.html',
};

const text = 'Hello there! I’m (Davide), a designer and AI-native builder: I design things and build them using AI. After graduating in communication design at (Politecnico di Milano), I worked for three years as a freelancer, collaborating with (Audience Zero) and (Corsedimoto.com) while delivering solo projects. In the meantime, I dedicated time to cofounding a music and art events collective. You can check some of my work (here). If you want to grab a coffee and talk about your feelings or just hire me, you can (contact) me whenever :]';


function parseText(text) {
    const parts = [];
    let buffer = '';
    let inParens = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '(') {
            if (buffer) {
                parts.push({ text: buffer, isStatic: false });
                buffer = '';
            }
            inParens = true;
        } else if (char === ')') {
            if (buffer) {
                parts.push({ text: buffer, isStatic: true });
                buffer = '';
            }
            inParens = false;
        } else {
            buffer += char;
        }
    }
    if (buffer) {
        parts.push({ text: buffer, isStatic: false });
    }
    return parts;
}

const container = document.getElementById('textContainer');
let fallingWords = new Set();
let fallenBodies = new Set();
let wordsMap = new Map();

// One item per dropped word: physics body + its DOM element + spawn origin
const fallingItems = [];

let touchActive = false;
let touchX = 0;
let touchY = 0;
let touchStartX = 0;
let touchStartY = 0;

// Dropped words are uncapped. Retirement still exists, but only as the reset
// path (and as the safety valve below) — not as a routine ceiling.
function retireItem(item) {
    if (!item) return;
    // Settled words stay in the world as static colliders now, so every body
    // reaching here is still in it — remove unconditionally.
    World.remove(engine.world, item.body);
    fallenBodies.delete(item.body);
    fallingWords.delete(item.el);
    item.el.remove();
}

function createFallingWord(text, rect, velocityX = 0, velocityY = 0) {
    const isMobile = isMobileView();

    // Size the collider from the word's ACTUAL laid-out box, not from a
    // per-character estimate. `text.length * 6` was wrong in both directions:
    // "I" got a 6x16 body (taller than the glyph is wide, so it wedged into
    // gaps) while wide words got colliders that didn't match their text. The
    // rect is the real measured size, so collider and glyph now agree.
    //
    // Still floored: Matter gives a zero-area rectangle mass 0 and inertia
    // NaN, its position becomes NaN on the first step, and from then on every
    // Engine.update throws inside the narrowphase.
    const bodyWidth = Math.max(rect.width, 4);
    const bodyHeight = Math.max(rect.height * 0.72, 4);
    const bodyX = rect.left + (rect.width / 2);
    const bodyY = rect.top + (rect.height / 2);

    // A word that isn't laid out (display:none, detached) has a zero rect, so
    // its centre would be NaN-free but meaningless; bail rather than simulate.
    if (!Number.isFinite(bodyX) || !Number.isFinite(bodyY)) return;

    const body = Bodies.rectangle(
        bodyX,
        bodyY,
        bodyWidth,
        bodyHeight,
        {
            restitution: isChrome ? 0.15 : (isMobile ? 0.2 : 0.3),
            friction: isChrome ? 0.85 : 0.8,
            frictionAir: isChrome ? (isMobile ? 0.03 : 0.015) : (isMobile ? 0.02 : 0.01),
            angle: 0,
            density: isChrome ? (isMobile ? 0.003 : 0.0015) : (isMobile ? 0.002 : 0.001),
            // fall asleep quickly once settled (default is 60 frames)
            sleepThreshold: 30
        }
    );

    // Last line of defence: a NaN or Infinity velocity from any caller becomes
    // a NaN body position, which poisons Matter's shared narrowphase and makes
    // every subsequent Engine.update throw. Clamp to a finite, sane range.
    const maxSpeed = 60;
    const sanitize = (v) => {
        if (!Number.isFinite(v)) return 0;
        return Math.max(-maxSpeed, Math.min(maxSpeed, v));
    };

    const velocityFactor = isChrome ? 0.85 : 1;
    Body.setVelocity(body, {
        x: sanitize(velocityX) * velocityFactor,
        y: sanitize(velocityY) * velocityFactor
    });

    World.add(engine.world, body);
    fallenBodies.add(body);

    const wordElement = document.createElement('div');
    wordElement.className = 'falling-word';
    wordElement.textContent = text;
    wordElement.style.left = `${rect.left}px`;
    wordElement.style.top = `${rect.top}px`;
    document.body.appendChild(wordElement);
    fallingWords.add(wordElement);

    fallingItems.push({
        body,
        el: wordElement,
        x0: bodyX,
        y0: bodyY,
        sleepPainted: false,
        stillFrames: 0,
        retired: false
    });

    // No ceiling on word count: words accumulate for as long as you keep
    // dropping them. What keeps this affordable is that settled words freeze
    // into static bodies (see the render loop) — they still collide, but skip
    // the integrator and never pair with each other, so the cost of an old
    // word decays to roughly a static DOM node.
}

// ── Physics + render loop ──────────────────────────────────────────────────
// Steps the engine once per display frame with the real elapsed time, so the
// simulation runs at the screen's refresh rate: 60fps on standard displays,
// 120fps on ProMotion/high-refresh screens, always at correct speed.
// Time the tab spent hidden is skipped instead of simulated (no slow motion,
// unlike Matter's default Runner whose delta smoothing caused the 2s lag).
let lastFrameTime = performance.now();
let lastDelta = 1000 / 60;

function frame(now) {
    let elapsed = now - lastFrameTime;
    lastFrameTime = now;

    if (elapsed <= 0 || elapsed > 100) {
        // Tab was hidden or timer glitch: keep the previous pace
        elapsed = lastDelta;
    } else if (elapsed > 34) {
        // Cap big hitches at ~2 standard frames
        elapsed = 34;
    }

    Engine.update(engine, elapsed, elapsed / lastDelta);
    lastDelta = elapsed;

    // Render: every dropped word follows its body.
    const mobile = isMobileView();
    for (let i = 0; i < fallingItems.length; i++) {
        const it = fallingItems[i];
        const body = it.body;

        // Retired words are out of the physics world entirely and already
        // painted at their final resting transform: nothing left to do.
        if (it.retired) continue;

        // Settled words don't move: paint them once, then skip until they wake
        if (body.isSleeping || body.isStatic) {
            if (it.sleepPainted) continue;
            it.sleepPainted = true;
        } else {
            it.sleepPainted = false;

            // Freeze a word solid only after it has been near-still for a
            // stretch of consecutive frames: a word at the apex of an arc is
            // slow for just an instant, so it keeps flying instead of
            // freezing mid-air.
            //
            // This is what makes an uncapped word count affordable, so it now
            // runs on desktop too (it used to be mobile-only, with the hard
            // cap doing the reclaiming). The thresholds are deliberately
            // looser than a pure "stopped" test: words low in a pile jostle
            // against their neighbours indefinitely and would never retire
            // under a stricter test, so the pile would grow without bound.
            if (body.speed < 0.25 && body.angularSpeed < 0.25) {
                it.stillFrames++;
                if (it.stillFrames > (mobile ? 20 : 30)) {
                    // Freeze it as a STATIC body rather than removing it from
                    // the world. Removing it was much cheaper, but it deleted
                    // the collider too, so later words fell straight through
                    // the settled pile — the "words slip between each other"
                    // problem. Measured over a 200-word pile: removing gives
                    // ~29px of interpenetration, going static gives ~2px, and
                    // costs ~0.03ms/step because static bodies skip the
                    // integrator and never pair with one another.
                    Body.setStatic(body, true);
                    it.retired = true;
                }
            } else {
                it.stillFrames = 0;
            }
        }

        const dx = body.position.x - it.x0;
        const dy = body.position.y - it.y0;
        const rotation = body.angle * (180 / Math.PI);
        it.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rotation}deg)`;
    }

    sweepOffscreen();

    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Safety valve for very long sessions. This is NOT a cap on word count: it
// only discards words that have left the viewport downwards, where they are
// permanently invisible. Words you can see are never touched, however many
// there are.
let sweepCounter = 0;
function sweepOffscreen() {
    // Once every ~2s of frames; the scan is cheap but pointless per-frame.
    if (++sweepCounter < 120) return;
    sweepCounter = 0;

    const limit = window.innerHeight + 200;
    let writeIndex = 0;

    for (let i = 0; i < fallingItems.length; i++) {
        const it = fallingItems[i];
        const y = it.body.position.y;

        // Below the viewport, or coordinates that have gone bad: discard.
        // On mobile there are no side walls, so a hard flick can send a word
        // past the edge of the ground — it then falls forever, never goes
        // still, and so would never retire on its own. Without this it would
        // stay in the physics world for the rest of the session.
        if (!Number.isFinite(y) || y > limit) {
            retireItem(it);
            continue;
        }
        fallingItems[writeIndex++] = it;
    }
    fallingItems.length = writeIndex;
}

function checkWordInSwipePath(wordElement, currentX, currentY) {
    if (wordElement.classList.contains('original-hidden')) {
        return false;
    }

    const rect = wordElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const distance = Math.sqrt(
        Math.pow(currentX - centerX, 2) +
        Math.pow(currentY - centerY, 2)
    );

    const proximityThreshold = Math.max(rect.width, 40);

    if (distance <= proximityThreshold) {
        const dx = currentX - touchX;
        const dy = currentY - touchY;
        const magnitude = Math.sqrt(dx * dx + dy * dy);

        let vx = 0, vy = 0;
        if (magnitude > 5) {
            const speedFactor = 5;
            vx = (dx / magnitude) * speedFactor;
            vy = (dy / magnitude) * speedFactor;
        }

        // Delegate to the word's own guarded drop handler rather than
        // spawning here: it owns the `original-hidden` flag and the restore
        // timeout, so a word can only be in flight once. Spawning directly
        // let this scanner re-drop the same word on every touchmove, which
        // leaked bodies until the frame loop stalled.
        if (!wordElement._drop) return false;
        wordElement._drop(vx, vy);

        return true;
    }

    return false;
}

function setupSwipeHandling() {
    if (isMobileView()) {
        document.addEventListener('touchstart', (e) => {
            touchActive = true;
            touchX = e.touches[0].clientX;
            touchY = e.touches[0].clientY;

            wordsMap.forEach((wordEl) => {
                if (wordEl.classList.contains('static') && !wordEl.classList.contains('original-hidden')) {
                    checkWordInSwipePath(wordEl, touchX, touchY);
                }
            });
        });

        // Touch events fire faster than the screen repaints, and each sweep
        // does a getBoundingClientRect() per word (a forced layout). Coalesce
        // to at most one sweep per animation frame.
        let scanQueued = false;
        let pendingX = 0;
        let pendingY = 0;

        document.addEventListener('touchmove', (e) => {
            if (!touchActive) return;

            pendingX = e.touches[0].clientX;
            pendingY = e.touches[0].clientY;

            if (scanQueued) return;
            scanQueued = true;

            requestAnimationFrame(() => {
                scanQueued = false;
                if (!touchActive) return;

                const currentX = pendingX;
                const currentY = pendingY;

                wordsMap.forEach((wordEl) => {
                    if (wordEl.classList.contains('static') && !wordEl.classList.contains('original-hidden')) {
                        checkWordInSwipePath(wordEl, currentX, currentY);
                    }
                });

                touchX = currentX;
                touchY = currentY;
            });
        });

        document.addEventListener('touchend', () => {
            touchActive = false;
        });

        document.addEventListener('touchcancel', () => {
            touchActive = false;
        });
    }
}

const segments = parseText(text);

// Remove the static SEO/no-JS fallback before building the interactive version
container.textContent = '';

segments.forEach((segment) => {
    if (segment.isStatic) {
        const link = document.createElement('a');
        link.href = links[segment.text] || '#';
        link.textContent = segment.text;
        link.className = 'word highlight';
        container.appendChild(link);
    } else {
        const words = segment.text.split(/(\s+)/);
        words.forEach(word => {
            // `split(/(\s+)/)` emits an empty string wherever a separator sits
            // at a segment boundary — which is every "(link)" here, since the
            // text before it ends in a space. `!/^\s+$/.test("")` is true, so
            // empty strings used to slip through and become zero-width bodies
            // (area 0, inertia NaN), which poisons Matter's narrowphase.
            if (word !== '' && !/^\s+$/.test(word)) {
                const span = document.createElement('span');
                span.textContent = word;
                span.className = 'word static';

                wordsMap.set(span.textContent + Math.random(), span);

                let interactionTimeout;
                let touchStartTime;

                const handleWordFall = (velocityX = 0, velocityY = 0) => {
                    if (!span.classList.contains('original-hidden')) {
                        if (interactionTimeout) {
                            clearTimeout(interactionTimeout);
                        }

                        const rect = span.getBoundingClientRect();
                        createFallingWord(span.textContent, rect, velocityX, velocityY);
                        span.classList.add('original-hidden');

                        interactionTimeout = setTimeout(() => {
                            span.classList.remove('original-hidden');
                        }, 5000);
                    }
                };

                // Used by the mouse-sweep path sampling below
                span._drop = handleWordFall;

                let mouseEnterTimer;
                if (!prefersReducedMotion) {
                    span.addEventListener('mouseenter', () => {
                        mouseEnterTimer = setTimeout(() => handleWordFall(), 10);
                    });
                    span.addEventListener('mouseleave', () => {
                        if (mouseEnterTimer) clearTimeout(mouseEnterTimer);
                    });
                }


                if (!prefersReducedMotion && isMobileView()) {
                    span.addEventListener('touchstart', (e) => {
                        e.preventDefault();
                        touchStartTime = Date.now();
                        touchStartX = e.touches[0].clientX;
                        touchStartY = e.touches[0].clientY;
                    });

                    span.addEventListener('touchend', (e) => {
                        e.preventDefault();
                        const touchEndX = e.changedTouches[0].clientX;
                        const touchEndY = e.changedTouches[0].clientY;

                        // A touchend can fire on a word whose touchstart never
                        // did (a swipe that began on a different word), leaving
                        // touchStartTime undefined and the start coords stale.
                        // Treat that as "not a gesture on this word".
                        if (touchStartTime === undefined) return;

                        // Date.now() has millisecond resolution, so a quick flick
                        // can start and end inside the same tick. Flooring at 1ms
                        // keeps `distance / touchDuration` finite: an Infinity here
                        // became an Infinity velocity, then a NaN body position,
                        // which corrupts Matter's narrowphase and throws
                        // "Cannot read properties of undefined (reading 'index')"
                        // on every later step — the frozen-page bug.
                        const touchDuration = Math.max(Date.now() - touchStartTime, 1);
                        const deltaX = touchEndX - touchStartX;
                        const deltaY = touchEndY - touchStartY;
                        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

                        // If it's a swipe (fast movement over sufficient distance)
                        if (touchDuration < 300 && distance > 30) {
                            const speed = distance / touchDuration;
                            const velocityFactor = isChrome ? 7 : 10;
                            const velocityX = (deltaX / distance) * speed * velocityFactor;
                            const velocityY = (deltaY / distance) * speed * velocityFactor;
                            handleWordFall(velocityX, velocityY);
                        } else if (touchDuration < 300) {
                            // Simple tap
                            handleWordFall();
                        }

                        // Consume it, so a later touchend on this word without a
                        // matching touchstart can't reuse a stale start time.
                        touchStartTime = undefined;
                    });
                }

                container.appendChild(span);
            } else {
                container.appendChild(document.createTextNode(word));
            }
        });
    }
});


// ── Resize: rebuild walls, pull bodies back inside, wake everything ────────
function handleResize() {
    World.remove(engine.world, bounds);
    bounds = createBounds();
    World.add(engine.world, bounds);
    setGravity();

    const w = window.innerWidth;
    const h = window.innerHeight;

    fallenBodies.forEach(body => {
        // Clamp bodies into the new viewport so they resettle visibly
        const x = Math.min(Math.max(body.position.x, 20), w - 20);
        const y = Math.min(body.position.y, h - 60);
        if (x !== body.position.x || y !== body.position.y) {
            Body.setPosition(body, { x, y });
        }
        if (body.isStatic) {
            Body.setStatic(body, false);
        }
        Sleeping.set(body, false);
    });

    // Settled words were frozen static and are skipped by the render loop, so
    // waking their bodies is not enough — clear the flags too, or they would
    // resettle in the physics world while their text stayed where it was.
    for (let i = 0; i < fallingItems.length; i++) {
        fallingItems[i].retired = false;
        fallingItems[i].stillFrames = 0;
        fallingItems[i].sleepPainted = false;
    }
}

let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResize, 100);
});
window.addEventListener('orientationchange', handleResize);

function resetFallenWords() {
    fallenBodies.forEach(body => World.remove(engine.world, body));
    fallingWords.forEach(element => element.remove());
    fallenBodies.clear();
    fallingWords.clear();
    fallingItems.length = 0;
}

// ── Mouse sweep (desktop) ───────────────────────────────────────────────────
// The browser samples the pointer, so a fast cursor sweep "jumps" over words
// between two mousemove events and their mouseenter never fires. This samples
// the path between events and drops every word it crossed, throwing it in the
// direction of the sweep.
function setupMouseSweep() {
    if (!window.matchMedia('(pointer: fine)').matches) return;

    let lastX = null, lastY = null, lastT = 0;

    document.addEventListener('mousemove', (e) => {
        const x = e.clientX, y = e.clientY, t = e.timeStamp;

        if (lastX !== null) {
            const dx = x - lastX;
            const dy = y - lastY;
            const dist = Math.hypot(dx, dy);

            if (dist > 8) {
                const dt = Math.max(t - lastT, 1);
                const speed = dist / dt; // px per ms
                const vx = (dx / dist) * Math.min(speed * 2, 5);
                const vy = (dy / dist) * Math.min(speed * 2, 5);

                const step = 12;
                for (let d = 0; d <= dist; d += step) {
                    const el = document.elementFromPoint(
                        lastX + dx * (d / dist),
                        lastY + dy * (d / dist)
                    );
                    if (el && el._drop) el._drop(vx, vy);
                }
            }
        }

        lastX = x;
        lastY = y;
        lastT = t;
    });
}
if (!prefersReducedMotion) {
    setupMouseSweep();

    // Initialize swipe handling
    setupSwipeHandling();
}
