/* Avatar 3D — three.js + three-vrm : chargement VRM, idle, lip-sync, émotions. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

/* Émotions LLM → expression VRM : premier nom disponible dans le modèle
   (VRM 0 / VRM 1 / modèles maison n'utilisent pas les mêmes noms ni la même casse) */
const EMOTION_MAP = {
  neutral: [],
  joy: ['happy', 'joy', 'fun'],
  angry: ['angry'],
  sad: ['sad', 'sorrow'],
  shy: ['relaxed', 'happy', 'joy', 'fun'],   /* poids réduit géré plus bas */
  surprised: ['surprised'],
};

/* intensité de chaque émotion (la surprise ouvre la bouche : on la modère) */
const EMOTION_WEIGHT = { joy: 0.8, angry: 0.85, sad: 0.8, shy: 0.5, surprised: 0.6 };

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

/* Émotions recomposées à partir des morceaux du visage (modèles VRoid : Fcl_BRW_*,
   Fcl_EYE_*, Fcl_MTH_*). Les expressions d'origine déforment tout le visage d'un
   bloc, bouche comprise : la bouche restait figée (fâchée, triste) ou sortait sous le
   menton (surprise) quand Kurisu parlait. Ici :
   - `upper` (sourcils + yeux) : toujours appliqué ;
   - `mouth` : seulement quand elle se tait — en parlant, la bouche est au lip-sync. */
const RECIPES = {
  neutral: { upper: {}, mouth: {} },
  joy: { upper: { BRW_Joy: 1, EYE_Joy: 0.35 }, mouth: { MTH_Fun: 0.6 } },
  angry: { upper: { BRW_Angry: 1, EYE_Angry: 0.75 }, mouth: { MTH_Angry: 0.25 } },
  sad: { upper: { BRW_Sorrow: 1, EYE_Sorrow: 0.7 }, mouth: { MTH_Sorrow: 0.3 } },
  shy: { upper: { BRW_Fun: 0.7, EYE_Joy: 0.2 }, mouth: { MTH_Fun: 0.4 } },
  surprised: { upper: { BRW_Surprised: 1, EYE_Surprised: 0.7 }, mouth: { MTH_Surprised: 0.35 } },
};
const RECIPE_PARTS = [...new Set(Object.values(RECIPES).flatMap((r) => [...Object.keys(r.upper), ...Object.keys(r.mouth)]))];

class Avatar {
  constructor() {
    this.vrm = null;
    this.available = new Set();
    this.emotionTargets = {};     // nom → poids cible
    this.emotionUntil = 0;
    this.lipTargets = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this._blinkNext = 1.5;
    this._blinkPhase = 0;
    this._speaking = false;
    this.onLoaded = null;
    /* fonction → {aa, ih, ou, ee, oh} | null, fournie par app.js (analyse audio) */
    this.lipSource = null;
    this._placeholder = null;
    this._emotion = 'neutral';
    this._parts = null;      /* nom court (BRW_Angry…) → [{mesh, index}] si le modèle les a */
    this._partValue = {};    /* poids courant (lissé) de chaque morceau */
    this._talk = 0;          /* 0 = se tait, 1 = parle (lissé) */
  }

  init(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, canvas.clientWidth / canvas.clientHeight, 0.1, 30);
    this.camera.position.set(0, 1.45, 1.75);
    this.camera.lookAt(0, 1.35, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.target.set(0, 1.35, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 4;
    this.controls.maxPolarAngle = Math.PI * 0.62;

    /* Vue 2D : caméra orthographique de face, cadrée buste, sans perspective ni
       rotation — Kurisu à plat comme sur l'écran d'Amadeus. */
    this.camera2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
    this.camera2d.position.set(0, 1.38, 3);
    this.camera2d.lookAt(0, 1.38, 0);
    this.view = '3d';

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.72);
    key.position.set(1.2, 2.2, 2.5);
    const rim = new THREE.DirectionalLight(0xffc27a, Math.PI * 0.4);
    rim.position.set(-2, 1.6, -1.5);
    const fill = new THREE.DirectionalLight(0xffdddd, Math.PI * 0.12);
    fill.position.set(-1.5, 1.0, 2.0);
    const amb = new THREE.AmbientLight(0xffffff, Math.PI * 0.22);
    this.scene.add(key, rim, fill, amb);
    this._lights = { key, rim, fill, amb };

    this._showPlaceholder();
    this.clock = new THREE.Clock();
    this._tick();
    window.addEventListener('resize', () => this._resize());
    /* suit les changements de taille du canvas (ouverture du tiroir conversation) */
    if (window.ResizeObserver) new ResizeObserver(() => this._resize()).observe(canvas);
  }

  _resize() {
    const c = this.canvas;
    if (!c.clientWidth || !c.clientHeight) return;
    const aspect = c.clientWidth / c.clientHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    /* buste : ~0,9 m de haut ; sur écran étroit on élargit pour garder les épaules */
    const halfH = Math.max(0.44, 0.3 / aspect);
    Object.assign(this.camera2d, { top: halfH, bottom: -halfH, left: -halfH * aspect, right: halfH * aspect });
    this.camera2d.updateProjectionMatrix();
    this.renderer.setSize(c.clientWidth, c.clientHeight, false);
  }

  get activeCamera() { return this.view === '2d' ? this.camera2d : this.camera; }

  /* '3d' : orbite libre, perspective. '2d' : portrait plat, éclairage d'aplat. */
  setView(view) {
    this.view = view === '2d' ? '2d' : '3d';
    const flat = this.view === '2d';
    this.controls.enabled = !flat;
    const { key, rim, fill, amb } = this._lights;
    /* 2D : lumière d'ambiance seule → aplats, ombres tranchées par le shader toon */
    key.intensity = Math.PI * (flat ? 0.3 : 0.72);
    rim.intensity = Math.PI * (flat ? 0 : 0.4);
    fill.intensity = Math.PI * (flat ? 0 : 0.12);
    amb.intensity = Math.PI * (flat ? 0.78 : 0.22);
    if (this.vrm?.lookAt) this.vrm.lookAt.target = this.activeCamera;
    this._resize();
  }

  /* ---------------- chargement VRM ---------------- */

  async loadDefault() {
    /* current.vrm (personnalisé) → kurisu.vrm → placeholder */
    for (const url of ['/api/avatar', '/vendor/models/kurisu.vrm?v=2']) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        if (buf.byteLength < 10000) continue;
        await this.loadFromBuffer(buf, url);
        return;
      } catch { /* essaie le suivant */ }
    }
    console.info('Aucun VRM trouvé — placeholder affiché, glisse un .vrm sur la fenêtre.');
  }

  async loadFromBuffer(buffer, name = 'vrm') {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(buffer.slice(0), '');
    if (this.vrm) {
      VRMUtils.deepDispose(this.vrm.scene);
      this.scene.remove(this.vrm.scene);
    }
    if (this._placeholder) { this.scene.remove(this._placeholder); this._placeholder = null; }

    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error(`${name} n'est pas un modèle VRM valide`);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
    if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    vrm.scene.rotation.y += 0; /* les VRM1 font face à +Z, caméra en +Z */

    this.vrm = vrm;
    this.scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.activeCamera;

    this.available = new Set(vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? []);
    console.info('Expressions VRM:', [...this.available].join(', '));
    const byLower = new Map([...this.available].map((n) => [n.toLowerCase(), n]));
    this._exprFor = Object.fromEntries(Object.entries(EMOTION_MAP).map(([emo, names]) =>
      [emo, names.map((n) => byLower.get(n)).find(Boolean) || null]));
    this._emotionExprs = [...new Set(Object.values(this._exprFor).filter(Boolean))];
    /* Une émotion qui touche la bouche (surprise : bouche ouverte) atténue le lip-sync
       au lieu de s'y additionner — sinon la bouche sort sous le menton. */
    /* Morceaux du visage disponibles ? → émotions recomposées ; sinon expressions d'origine */
    /* En VRM 0, les noms des morphs sont dans primitives[].extras.targetNames : three.js
       ne les reprend pas (il n'a que des numéros). On les relit dans le JSON glTF. */
    const json = gltf.parser.json;
    const namesOf = (meshIndex) => {
      const m = json.meshes?.[meshIndex];
      return m?.extras?.targetNames || m?.primitives?.[0]?.extras?.targetNames || null;
    };
    const parts = {};
    vrm.scene.traverse((o) => {
      if (!o.morphTargetInfluences) return;
      const assoc = gltf.parser.associations.get(o);
      const names = assoc?.meshes != null ? namesOf(assoc.meshes) : null;
      const entries = names ? names.map((n, i) => [n, i]) : Object.entries(o.morphTargetDictionary || {});
      for (const [key, index] of entries) {
        const short = String(key).split('Fcl_')[1];
        if (short && RECIPE_PARTS.includes(short)) (parts[short] ||= []).push({ mesh: o, index });
      }
    });
    const complete = RECIPE_PARTS.every((p) => parts[p]);
    this._parts = complete ? parts : null;
    this._partValue = {};
    if (this._parts) {
      this._emotionExprs = [];   /* on n'utilise plus les expressions « tout le visage » */
    } else {
      for (const n of this._emotionExprs) {
        const ex = vrm.expressionManager?.getExpression(n);
        if (ex) ex.overrideMouth = 'blend';
      }
    }
    console.info('Émotions :', this._parts ? 'recomposées (sourcils/yeux/bouche séparés)' : 'expressions du modèle');
    if (this.onLoaded) this.onLoaded(vrm, name);
  }

  _showPlaceholder() {
    const geo = new THREE.IcosahedronGeometry(0.28, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0x5b6875, wireframe: true, transparent: true, opacity: 0.6 });
    this._placeholder = new THREE.Mesh(geo, mat);
    this._placeholder.position.set(0, 1.32, 0);
    this.scene.add(this._placeholder);
  }

  /* ---------------- émotions & parole ---------------- */

  setEmotion(emotion, durationMs = 6000) {
    const targets = {};
    const base = EMOTION_MAP[emotion] ? emotion : 'neutral';
    this._emotion = base;
    const name = this._parts ? null : this._exprFor?.[base];
    if (name) targets[name] = EMOTION_WEIGHT[base] ?? 0.8;
    this.emotionTargets = targets;
    this.emotionUntil = performance.now() + durationMs;
  }

  setSpeaking(speaking) { this._speaking = speaking; }

  /* ---------------- boucle de rendu ---------------- */

  _tick() {
    requestAnimationFrame(() => this._tick());
    if (this.paused) { this.clock.getDelta(); return; }   /* portrait 2D affiché : pas de rendu 3D */
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    if (this._placeholder) {
      this._placeholder.rotation.y += dt * 0.6;
      this._placeholder.position.y = 1.32 + Math.sin(t * 1.4) * 0.03;
    }

    const vrm = this.vrm;
    if (vrm) {
      /* respiration + léger balancement */
      const chest = vrm.humanoid.getNormalizedBoneNode('chest');
      const spine = vrm.humanoid.getNormalizedBoneNode('spine');
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (chest) chest.rotation.x = Math.sin(t * 1.1) * 0.02;
      if (spine) spine.rotation.z = Math.sin(t * 0.4) * 0.015;

      /* bras détendus (sortie de la T-pose du modèle) */
      const lArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
      const rArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      const lElbow = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
      const rElbow = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
      if (lArm) lArm.rotation.z = 1.30 + Math.sin(t * 1.1) * 0.015;
      if (rArm) rArm.rotation.z = -1.30 - Math.sin(t * 1.1) * 0.015;
      if (lElbow) lElbow.rotation.y = -0.25;
      if (rElbow) rElbow.rotation.y = 0.25;

      if (head) {
        head.rotation.z += (Math.sin(t * 0.33) * 0.03 - head.rotation.z) * 0.02;
        head.rotation.y += (Math.sin(t * 0.21) * 0.06 - head.rotation.y) * 0.02;
      }

      /* clignements */
      this._blinkNext -= dt;
      const em = vrm.expressionManager;
      if (em) {
        if (this._blinkNext <= 0) { this._blinkPhase = 0.18; this._blinkNext = 1.5 + Math.random() * 4; }
        if (this._blinkPhase > 0) {
          this._blinkPhase -= dt;
          const w = this._blinkPhase > 0 ? 1 : 0;
          this._setExpr(['blink'], w);
        } else this._setExpr(['blink'], 0);

        /* émotions : cibles avec fondu, retour à neutre après expiration */
        const expired = performance.now() > this.emotionUntil;
        for (const name of this._emotionExprs || []) {
          const target = expired ? 0 : (this.emotionTargets[name] ?? 0);
          const cur = em.getValue(name) ?? 0;
          em.setValue(name, cur + (target - cur) * Math.min(1, dt * 4));
        }

        /* lip-sync */
        const lips = this.lipSource ? this.lipSource() : null;
        let open = 0;
        for (const v of VISEMES) {
          const target = lips ? (lips[v] ?? 0) : 0;
          const cur = em.getValue(v) ?? 0;
          em.setValue(v, cur + (target - cur) * 0.45);
          open += target;
        }
        /* « parle » lissé : la bouche de l'émotion s'efface vite quand elle parle,
           et revient doucement quand elle se tait */
        const talking = lips && open > 0.04 ? 1 : 0;
        this._talk += (talking - this._talk) * Math.min(1, dt * (talking ? 12 : 3));
      }

      vrm.update(dt);
      if (this._parts) this._applyParts(dt);
    }

    if (this.view === '3d') this.controls.update();
    this.renderer.render(this.scene, this.activeCamera);
  }

  /* Applique l'émotion recomposée (après vrm.update : ces morceaux ne sont liés à
     aucune expression du modèle, rien ne les écrase). */
  _applyParts(dt) {
    const expired = performance.now() > this.emotionUntil;
    const r = RECIPES[expired ? 'neutral' : this._emotion] || RECIPES.neutral;
    const k = Math.min(1, dt * 5);
    for (const part of RECIPE_PARTS) {
      const target = (r.upper[part] ?? 0) + (r.mouth[part] ?? 0) * (1 - this._talk);
      const cur = this._partValue[part] ?? 0;
      const v = cur + (target - cur) * k;
      this._partValue[part] = v;
      for (const { mesh, index } of this._parts[part]) mesh.morphTargetInfluences[index] = v;
    }
  }

  _setExpr(names, weight) {
    for (const n of names) this.vrm?.expressionManager?.setValue(n, weight);
  }
}

export const avatar = new Avatar();
