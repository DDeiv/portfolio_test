const Engine = Matter.Engine,
    Runner = Matter.Runner,
    Bodies = Matter.Bodies,
    World = Matter.World,
    Body = Matter.Body,
    Sleeping = Matter.Sleeping;

const isChrome = navigator.userAgent.indexOf('Chrome') > -1;
const isMobileView = () => window.innerWidth <= 768;

// enableSleeping lets settled bodies rest without freezing them forever:
// they wake up again when gravity changes (resize, gyroscope, shake).
const engine = Engine.create({
    enableSleeping: true,
    timing: {
        timeScale: 0.85,
        delta: 1000 / 60
    }
});
const runner = Runner.create();

let motionActive = false;
let baseGravity = 1;

const setGravity = () => {
    baseGravity = isChrome ?
        (isMobileView() ? 1.0 : 0.6) :
        (isMobileView() ? 2.0 : 1.3);
    if (!motionActive) {
        engine.world.gravity.x = 0;
        engine.world.gravity.y = baseGravity;
    }
};
setGravity();

Runner.run(runner, engine);

// ── Boundaries: ground + side walls + ceiling ──────────────────────────────
// Walls keep the fallen words inside the viewport, so they can react to
// window resizing and to gyroscope gravity without flying off-screen.
let bounds = [];

const createBounds = () => {
    const t = 60;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return [
        // ground (same position as before: top edge at h - 40)
        Bodies.rectangle(w / 2, h - 10, w, t, {
            isStatic: true,
            friction: 0.85,
            restitution: 0.15
        }),
        // left wall
        Bodies.rectangle(-t / 2, h / 2, t, h * 4, { isStatic: true }),
        // right wall
        Bodies.rectangle(w + t / 2, h / 2, t, h * 4, { isStatic: true }),
        // ceiling
        Bodies.rectangle(w / 2, -t / 2, w * 4, t, { isStatic: true })
    ];
};

bounds = createBounds();
World.add(engine.world, bounds);

const links = {
    'Politecnico di Milano': 'https://www.design.polimi.it/',
    'Davide': 'mailto:davidebocchi@icloud.com',
    'Audience Zero': 'https://www.audiencezero.com',
    'Corsedimoto.com': 'https://www.corsedimoto.com/',
    'contact': 'mailto:davidebocchi@icloud.com',
    'here': 'lavori.html',
};

const text = 'Hello there! I’m (Davide), I’m a creative technologist, exploring AI. After graduating in communication design at (Politecnico di Milano), I worked for three years as a freelancer, collaborating with (Audience Zero) and (Corsedimoto.com) while delivering solo projects. In the meantime, I dedicated time to cofounding a music and art events collective. You can check some of my work (here). If you want to grab a coffee and talk about your feelings or just hire me, you can (contact) me whenever :]';


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
            frictionAir: isChrome ? (isMobile ? 0.04 : 0.025) : (isMobile ? 0.02 : 0.01),
            angle: 0,
            density: isChrome ? (isMobile ? 0.003 : 0.0015) : (isMobile ? 0.002 : 0.001),
            // fall asleep quickly once settled (default is 60 frames)
            sleepThreshold: 30
        }
    );

    const velocityFactor = isChrome ? 0.7 : 1;
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

    fallingItems.push({ body, el: wordElement, x0: bodyX, y0: bodyY, sleepPainted: false });
    trimFallen();
}

// Cap the total number of words lying around so the simulation never
// degrades, no matter how much someone plays with it.
const MAX_FALLEN = 100;

function trimFallen() {
    while (fallingItems.length > MAX_FALLEN) {
        const oldest = fallingItems.shift();
        World.remove(engine.world, oldest.body);
        fallenBodies.delete(oldest.body);
        fallingWords.delete(oldest.el);
        oldest.el.remove();
    }
}

// ── Single render loop for every dropped word ──────────────────────────────
// (Previously each word had its own loop that stopped once the word settled,
// so settled words could never move again. Now they always follow their body.)
function renderLoop() {
    for (let i = 0; i < fallingItems.length; i++) {
        const it = fallingItems[i];

        // Sleeping words don't move: paint them once, then skip until they wake
        if (it.body.isSleeping) {
            if (it.sleepPainted) continue;
            it.sleepPainted = true;
        } else {
            it.sleepPainted = false;
        }

        const dx = it.body.position.x - it.x0;
        const dy = it.body.position.y - it.y0;
        const rotation = it.body.angle * (180 / Math.PI);
        it.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rotation}deg)`;
    }
    requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

function wakeAll() {
    fallenBodies.forEach(body => Sleeping.set(body, false));
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

                let mouseEnterTimer;
                span.addEventListener('mouseenter', () => {
                    mouseEnterTimer = setTimeout(() => handleWordFall(), 10);
                });
                span.addEventListener('mouseleave', () => {
                    if (mouseEnterTimer) clearTimeout(mouseEnterTimer);
                });


                if (isMobileView()) {
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

// ── Gyroscope gravity + shake-to-drop (mobile) ─────────────────────────────
const motionBtn = document.getElementById('motionBtn');
let lastShakeTime = 0;

function handleOrientation(e) {
    if (e.gamma === null || e.beta === null) return;

    // gamma: left/right tilt, beta: front/back tilt
    const gx = Math.max(-1, Math.min(1, e.gamma / 45));
    const gy = Math.max(-1, Math.min(1, e.beta / 45));

    const prevX = engine.world.gravity.x;
    const prevY = engine.world.gravity.y;

    engine.world.gravity.x = gx * baseGravity;
    engine.world.gravity.y = gy * baseGravity;

    // Wake settled words when the direction of gravity actually changes
    if (Math.abs(engine.world.gravity.x - prevX) > 0.05 ||
        Math.abs(engine.world.gravity.y - prevY) > 0.05) {
        wakeAll();
    }
}

function shakeEverything() {
    // Drop every word still standing in the paragraph
    wordsMap.forEach((span) => {
        if (!span.classList.contains('original-hidden')) {
            const rect = span.getBoundingClientRect();
            createFallingWord(
                span.textContent,
                rect,
                (Math.random() - 0.5) * 12,
                -(4 + Math.random() * 6)
            );
            span.classList.add('original-hidden');
            setTimeout(() => {
                span.classList.remove('original-hidden');
            }, 5000);
        }
    });

    // Toss the words already lying around
    fallenBodies.forEach(body => {
        Sleeping.set(body, false);
        Body.setVelocity(body, {
            x: (Math.random() - 0.5) * 14,
            y: -(6 + Math.random() * 8)
        });
    });
}

function handleMotion(e) {
    const a = e.acceleration;
    if (!a) return;

    const magnitude = Math.sqrt(
        (a.x || 0) * (a.x || 0) +
        (a.y || 0) * (a.y || 0) +
        (a.z || 0) * (a.z || 0)
    );

    if (magnitude > 18 && Date.now() - lastShakeTime > 1200) {
        lastShakeTime = Date.now();
        shakeEverything();
    }
}

async function enableMotion() {
    try {
        // iOS 13+ requires an explicit permission request from a user gesture
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            const response = await DeviceOrientationEvent.requestPermission();
            if (response !== 'granted') return;
        }
        if (typeof DeviceMotionEvent !== 'undefined' &&
            typeof DeviceMotionEvent.requestPermission === 'function') {
            try { await DeviceMotionEvent.requestPermission(); } catch (err) { /* optional */ }
        }

        window.addEventListener('deviceorientation', handleOrientation);
        window.addEventListener('devicemotion', handleMotion);
        motionActive = true;

        if (motionBtn) motionBtn.style.display = 'none';
    } catch (err) {
        if (motionBtn) motionBtn.style.display = 'none';
    }
}

if (motionBtn && isMobileView() && 'ontouchstart' in window &&
    typeof DeviceOrientationEvent !== 'undefined') {
    motionBtn.style.display = 'block';
    motionBtn.addEventListener('click', enableMotion);
}

// Initialize swipe handling
setupSwipeHandling();
