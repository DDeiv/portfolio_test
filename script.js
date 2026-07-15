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

function createFallingWord(text, rect, velocityX = 0, velocityY = 0) {
    const isMobile = isMobileView();
    const bodyWidth = text.length * (isMobile ? 6 : 8);
    const bodyHeight = isMobile ? 16 : 20;
    const bodyX = rect.left + (rect.width / 2);
    const bodyY = rect.top + (rect.height / 2);

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

    const velocityFactor = isChrome ? 0.85 : 1;
    Body.setVelocity(body, {
        x: velocityX * velocityFactor,
        y: velocityY * velocityFactor
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
        stillFrames: 0
    });
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

        // Settled words don't move: paint them once, then skip until they wake
        if (body.isSleeping || body.isStatic) {
            if (it.sleepPainted) continue;
            it.sleepPainted = true;
        } else {
            it.sleepPainted = false;

            // On mobile, freeze a word solid only after it has been still for
            // ~20 consecutive frames: a word at the apex of an arc is slow for
            // just an instant, so it keeps flying instead of freezing mid-air.
            if (mobile) {
                if (body.speed < 0.05 && body.angularSpeed < 0.05) {
                    it.stillFrames++;
                    if (it.stillFrames > 20) {
                        Body.setStatic(body, true);
                    }
                } else {
                    it.stillFrames = 0;
                }
            }
        }

        const dx = body.position.x - it.x0;
        const dy = body.position.y - it.y0;
        const rotation = body.angle * (180 / Math.PI);
        it.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rotation}deg)`;
    }

    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

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

        createFallingWord(wordElement.textContent, rect, vx, vy);
        wordElement.classList.add('original-hidden');

        setTimeout(() => {
            wordElement.classList.remove('original-hidden');
        }, 5000);

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

        document.addEventListener('touchmove', (e) => {
            if (!touchActive) return;

            const currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;

            wordsMap.forEach((wordEl) => {
                if (wordEl.classList.contains('static') && !wordEl.classList.contains('original-hidden')) {
                    checkWordInSwipePath(wordEl, currentX, currentY);
                }
            });

            touchX = currentX;
            touchY = currentY;
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
            if (!/^\s+$/.test(word)) {
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

                        const touchDuration = Date.now() - touchStartTime;
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
