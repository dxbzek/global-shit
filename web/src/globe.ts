import {
  ArcGisMapServerImageryProvider,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  defined,
  Ellipsoid,
  EllipsoidTerrainProvider,
  GeoJsonDataSource,
  Ion,
  JulianDate,
  Math as CMath,
  OpenStreetMapImageryProvider,
  Rectangle,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  ShadowMode,
  Viewer,
  createWorldImageryAsync,
  createWorldTerrainAsync,
  Cesium3DTileset,
  Entity,
  CallbackProperty,
  PolylineGlowMaterialProperty,
  HeightReference,
  LabelStyle,
  VerticalOrigin,
  Cartesian2,
  NearFarScalar,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

/**
 * The globe.
 *
 * Imagery is deliberately indirected through IMAGERY below: the default needs
 * no key at all, and Cesium Ion or Google Photorealistic 3D Tiles switch on
 * when their key is present. Swapping satellite sources later means adding one
 * entry, not rewriting the viewer.
 */

export type ImagerySource = 'esri' | 'ion' | 'osm' | 'google3d';

export type Status = 'war' | 'conflict' | 'tension' | 'peace' | 'unknown';

/*
 * Status fills, in the same print tones the interface uses. Alpha stays low
 * because the imagery has to read through them, and these are deliberately
 * desaturated: on a black field a saturated fill reads as a glowing overlay
 * rather than as ink.
 */
const STATUS_FILL: Record<Status, Color> = {
  war: Color.fromCssColorString('#c8372d').withAlpha(0.46),
  conflict: Color.fromCssColorString('#b86b2e').withAlpha(0.38),
  tension: Color.fromCssColorString('#b9972f').withAlpha(0.26),
  peace: Color.fromCssColorString('#4f7a54').withAlpha(0.14),
  unknown: Color.fromCssColorString('#55504a').withAlpha(0.0),
};

const STATUS_OUTLINE: Record<Status, Color> = {
  war: Color.fromCssColorString('#d9574c'),
  conflict: Color.fromCssColorString('#c98753'),
  tension: Color.fromCssColorString('#cbad53'),
  peace: Color.fromCssColorString('#6d9672'),
  unknown: Color.fromCssColorString('#ede8e0').withAlpha(0.22),
};

/* Selection is paper-white, not a colour: the same inversion the chips use. */
const SELECTED_OUTLINE = Color.fromCssColorString('#ede8e0');

export interface GlobeOptions {
  container: HTMLElement;
  /** Lighter 110m geometry on small screens, 50m on desktop. */
  lowDetail: boolean;
  reducedMotion: boolean;
  imagery: ImagerySource;
  ionToken?: string | null;
  googleKey?: string | null;
  onPick: (iso2: string | null) => void;
  onHover: (info: { iso2: string; x: number; y: number } | null) => void;
  /**
   * Called when satellite imagery cannot load. Cesium reports tile failures
   * through an event and logs raw minified errors to the console when nothing
   * is listening, so this is handled rather than left to leak.
   */
  onImageryError?: (message: string) => void;
}

export class Globe {
  readonly viewer: Viewer;
  private countries?: GeoJsonDataSource;
  private statuses = new Map<string, Status>();
  private selected: string | null = null;
  private idleSpin: boolean;
  private readonly reducedMotion: boolean;
  private lineEntities: Entity[] = [];
  private pinEntities: Entity[] = [];
  private tileset?: Cesium3DTileset;
  /** Drives the conflict-zone pulse without re-rendering geometry. */
  private pulsePhase = 0;
  /** Imagery failures are reported once, not once per failed tile. */
  private imageryErrorReported = false;

  constructor(private readonly opts: GlobeOptions) {
    this.reducedMotion = opts.reducedMotion;
    this.idleSpin = !opts.reducedMotion;

    if (opts.ionToken) Ion.defaultAccessToken = opts.ionToken;

    this.viewer = new Viewer(opts.container, {
      // Every piece of Cesium's own chrome is off: this app supplies its own.
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      scene3DOnly: true,
      // No default base layer. Without this, Cesium creates an Ion imagery
      // layer and requests api.cesium.com on every load, even though
      // setImagery replaces it immediately with the key-free provider.
      baseLayer: false,
      sceneMode: SceneMode.SCENE3D,
      // Flat ellipsoid by default; real terrain needs an Ion token and costs
      // bandwidth that buys little at the zoom levels this app uses.
      terrainProvider: new EllipsoidTerrainProvider(),
      shadows: false,
      terrainShadows: ShadowMode.DISABLED,
      contextOptions: {
        webgl: {
          // Lets the page background show through at the globe's edge.
          alpha: true,
          powerPreference: 'high-performance',
        },
      },
    });

    const { scene, clock } = this.viewer;
    scene.backgroundColor = Color.TRANSPARENT;
    scene.globe.baseColor = Color.fromCssColorString('#0d0c0a');

    // Atmosphere. The soft limb glow is the single most recognisable thing
    // about a satellite globe, so it is tuned up rather than left default.
    // Scene.skyAtmosphere is absent when the scene is 2D, hence the guard.
    const sky = scene.skyAtmosphere;
    if (sky) {
      sky.show = true;
      // Desaturated and dimmer: on a true-black field the default blue limb
      // glow is the loudest thing on screen, which is not what it should be.
      sky.brightnessShift = 0.04;
      sky.saturationShift = -0.35;
      sky.hueShift = 0.0;
    }
    scene.globe.showGroundAtmosphere = true;
    scene.globe.atmosphereBrightnessShift = 0.0;
    scene.fog.enabled = true;
    scene.fog.density = 0.00012;

    // Lighting off: a day/night terminator would hide half the countries,
    // which defeats a map whose entire job is comparing them.
    scene.globe.enableLighting = false;
    scene.highDynamicRange = false;

    // Keeps the camera from tunnelling through the surface on fast zooms.
    scene.screenSpaceCameraController.minimumZoomDistance = 180_000;
    scene.screenSpaceCameraController.maximumZoomDistance = 36_000_000;
    scene.screenSpaceCameraController.enableTilt = true;
    scene.screenSpaceCameraController.enableLook = false;

    clock.shouldAnimate = false;

    void this.setImagery(opts.imagery);
    this.installIdleSpin();
    this.installPulse();
    this.installPicking();

    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(12, 22, 24_000_000),
    });
  }

  /**
   * Attaches an error listener to an imagery provider.
   *
   * Cesium's TileProviderError logs to the console only when its event has no
   * listeners, so handling it both silences the raw minified output and lets
   * the app tell the reader that imagery, specifically, is unavailable while
   * the rest of the globe still works.
   */
  private watchImagery(provider: { errorEvent?: { addEventListener: (fn: (e: unknown) => void) => void } }): void {
    provider.errorEvent?.addEventListener((event) => {
      if (this.imageryErrorReported) return;
      this.imageryErrorReported = true;
      const message =
        event && typeof event === 'object' && 'message' in event && typeof event.message === 'string'
          ? event.message
          : 'tile request failed';
      this.opts.onImageryError?.(message);
    });
  }

  /** Swaps the imagery layer in place, keeping the camera and overlays. */
  async setImagery(source: ImagerySource): Promise<void> {
    const layers = this.viewer.imageryLayers;

    if (this.tileset) {
      this.viewer.scene.primitives.remove(this.tileset);
      this.tileset = undefined;
      this.viewer.scene.globe.show = true;
    }

    try {
      switch (source) {
        case 'ion': {
          if (!this.opts.ionToken) throw new Error('no Ion token');
          const provider = await createWorldImageryAsync();
          layers.removeAll();
          layers.addImageryProvider(provider);
          this.watchImagery(provider);
          this.viewer.terrainProvider = await createWorldTerrainAsync();
          break;
        }
        case 'google3d': {
          if (!this.opts.googleKey) throw new Error('no Google Maps key');
          // Photorealistic 3D Tiles replace the globe surface entirely, so the
          // ellipsoid is hidden rather than drawn underneath.
          this.tileset = await Cesium3DTileset.fromUrl(
            `https://tile.googleapis.com/v1/3dtiles/root.json?key=${this.opts.googleKey}`,
            { showCreditsOnScreen: true },
          );
          this.viewer.scene.primitives.add(this.tileset);
          this.viewer.scene.globe.show = false;
          break;
        }
        case 'osm': {
          const provider = new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' });
          layers.removeAll();
          layers.addImageryProvider(provider);
          this.watchImagery(provider);
          break;
        }
        case 'esri':
        default: {
          // Default: free, key-free satellite imagery.
          const provider = await ArcGisMapServerImageryProvider.fromUrl(
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
            { enablePickFeatures: false },
          );
          layers.removeAll();
          layers.addImageryProvider(provider);
          this.watchImagery(provider);
          break;
        }
      }
    } catch (err) {
      // A failed imagery swap must not leave a blank globe, so fall back to
      // the key-free provider unless that is what already failed. When even
      // that fails, the globe keeps its base colour and country layer, and the
      // reader is told imagery is missing rather than left wondering.
      if (source !== 'esri') {
        await this.setImagery('esri');
        return;
      }
      if (!this.imageryErrorReported) {
        this.imageryErrorReported = true;
        this.opts.onImageryError?.(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Loads country polygons and paints them from the status map. */
  async loadCountries(statuses: Map<string, Status>): Promise<void> {
    this.statuses = statuses;
    /*
     * Resolved against the document rather than the origin root. An absolute
     * '/data/...' only works when the app is served at the root; under any
     * sub-path it 404s and the globe loads with no countries on it.
     */
    const file = this.opts.lowDetail ? 'countries-110m.geojson' : 'countries-50m.geojson';
    const url = new URL(`data/${file}`, document.baseURI).href;

    const ds = await GeoJsonDataSource.load(url, {
      clampToGround: false,
      // Stroke and fill are set per entity below; these are only defaults.
      stroke: STATUS_OUTLINE.unknown,
      fill: Color.TRANSPARENT,
      strokeWidth: 1,
    });

    this.countries = ds;
    await this.viewer.dataSources.add(ds);
    this.repaint();
  }

  /** Re-applies status colours. Cheap enough to call on every data refresh. */
  setStatuses(statuses: Map<string, Status>): void {
    this.statuses = statuses;
    this.repaint();
  }

  private repaint(): void {
    if (!this.countries) return;
    for (const entity of this.countries.entities.values) {
      const iso2 = (entity.properties?.iso2?.getValue(JulianDate.now()) as string) ?? entity.id;
      const status = this.statuses.get(iso2) ?? 'unknown';
      const isSelected = this.selected === iso2;
      if (!entity.polygon) continue;

      // Selection is carried by the outline alone. Filling it paper-white
      // flattened the country into a grey blob and hid the imagery beneath,
      // which is the one thing the globe is there to show.
      entity.polygon.material = new ColorMaterialProperty(
        isSelected ? STATUS_FILL[status].withAlpha(Math.max(0.1, STATUS_FILL[status].alpha)) : STATUS_FILL[status],
      );
      entity.polygon.outline = new ConstantProperty(true);
      entity.polygon.outlineColor = new ConstantProperty(
        isSelected ? SELECTED_OUTLINE : STATUS_OUTLINE[status],
      );
      // Cesium ignores outlineWidth above 1 on most platforms, so emphasis
      // comes from colour and fill rather than stroke weight.
      entity.polygon.outlineWidth = new ConstantProperty(isSelected ? 3 : 1);
      entity.polygon.height = new ConstantProperty(0);
      entity.polygon.perPositionHeight = new ConstantProperty(false);
    }
  }

  /**
   * Conflict zones breathe. Rather than animate every polygon, the fill alpha
   * of war and conflict countries is driven by one shared phase, so the cost
   * is a single property read per frame regardless of how many are pulsing.
   */
  private installPulse(): void {
    if (this.reducedMotion) return;
    this.viewer.scene.preRender.addEventListener(() => {
      this.pulsePhase = (performance.now() % 2600) / 2600;
    });
  }

  private pulseAlpha(base: number): number {
    // Smooth 0..1..0 over the phase.
    const wave = 0.5 - 0.5 * Math.cos(this.pulsePhase * Math.PI * 2);
    return base * (0.78 + 0.22 * wave);
  }

  /**
   * Slow idle spin. Stops on any interaction and on a selection, because a
   * moving globe makes a panel hard to read.
   */
  private installIdleSpin(): void {
    if (this.reducedMotion) return;
    const camera = this.viewer.camera;
    let last = performance.now();

    this.viewer.clock.onTick.addEventListener(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!this.idleSpin) return;
      // About one revolution every six minutes: present, not distracting.
      camera.rotate(Cartesian3.UNIT_Z, -dt * 0.0175);
    });

    this.viewer.clock.shouldAnimate = true;

    const stop = () => this.setIdleSpin(false);
    const el = this.viewer.canvas;
    for (const ev of ['pointerdown', 'wheel', 'touchstart'] as const) {
      el.addEventListener(ev, stop, { passive: true });
    }
  }

  setIdleSpin(on: boolean): void {
    this.idleSpin = on && !this.reducedMotion;
  }

  private installPicking(): void {
    const handler = new ScreenSpaceEventHandler(this.viewer.canvas);

    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = this.viewer.scene.pick(movement.position);
      const iso2 = this.isoFromPick(picked);
      this.opts.onPick(iso2);
    }, ScreenSpaceEventType.LEFT_CLICK);

    let lastHover: string | null = null;
    handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      const picked = this.viewer.scene.pick(movement.endPosition);
      const iso2 = this.isoFromPick(picked);
      this.viewer.canvas.style.cursor = iso2 ? 'pointer' : 'grab';
      if (iso2 === lastHover) return;
      lastHover = iso2;
      this.opts.onHover(
        iso2 ? { iso2, x: movement.endPosition.x, y: movement.endPosition.y } : null,
      );
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  private isoFromPick(picked: unknown): string | null {
    if (!defined(picked)) return null;
    const entity = (picked as { id?: unknown }).id;
    if (!(entity instanceof Entity)) return null;
    const value = entity.properties?.iso2?.getValue(JulianDate.now());
    return typeof value === 'string' ? value : null;
  }

  /**
   * Flies the camera to frame a country.
   *
   * The destination comes from the country's bounding box rather than a fixed
   * altitude, so Russia and Monaco both end up filling a similar share of the
   * screen. The box is padded and clamped: an unpadded box puts the coastline
   * flush against the panel edge.
   */
  flyTo(bbox: [number, number, number, number], centroid: [number, number]): void {
    const [west, south, east, north] = bbox;
    const padLon = Math.max(1.5, (east - west) * 0.35);
    const padLat = Math.max(1.5, (north - south) * 0.35);

    // Leave room on the right for the desktop panel by biasing the framing.
    const panelBias = window.innerWidth > 900 ? (east - west) * 0.5 + padLon : 0;

    const rect = Rectangle.fromDegrees(
      Math.max(-180, west - padLon),
      Math.max(-85, south - padLat),
      Math.min(180, east + padLon + panelBias),
      Math.min(85, north + padLat),
    );

    const valid = rect.east > rect.west && rect.north > rect.south;
    const destination = valid
      ? rect
      : Cartesian3.fromDegrees(centroid[0], centroid[1], 2_400_000);

    this.setIdleSpin(false);
    this.viewer.camera.flyTo({
      destination,
      duration: this.reducedMotion ? 0 : 1.6,
      // A gentle ease-out; Cesium's default feels mechanical at globe scale.
      easingFunction: (t: number) => 1 - Math.pow(1 - t, 3),
      orientation: { heading: 0, pitch: CMath.toRadians(-90), roll: 0 },
    });
  }

  /** Returns the camera to the whole-globe view. */
  flyHome(): void {
    this.setIdleSpin(!this.reducedMotion);
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(12, 22, 24_000_000),
      duration: this.reducedMotion ? 0 : 1.4,
      easingFunction: (t: number) => 1 - Math.pow(1 - t, 3),
    });
  }

  select(iso2: string | null): void {
    this.selected = iso2;
    this.repaint();
  }

  /**
   * Draws alliance and adversary lines from one country to others.
   *
   * Each line is an arc raised above the surface so it reads as a connection
   * rather than a border, and it draws itself on: the polyline's positions are
   * a CallbackProperty that reveals the arc over time.
   */
  drawLines(
    from: [number, number],
    targets: Array<{ centroid: [number, number]; kind: 'pact' | 'relation' | 'adversary' }>,
  ): void {
    this.clearLines();
    const start = performance.now();
    const drawMs = this.reducedMotion ? 0 : 900;

    targets.forEach((target, i) => {
      const colour =
        target.kind === 'adversary'
          ? Color.fromCssColorString('#c8372d')
          : target.kind === 'pact'
            ? Color.fromCssColorString('#ede8e0')
            : Color.fromCssColorString('#9a938a');

      // Stagger each line so they appear to fan out from the country.
      const delay = this.reducedMotion ? 0 : i * 55;
      const arc = greatCircleArc(from, target.centroid, 48);

      const positions = new CallbackProperty(() => {
        if (drawMs === 0) return arc;
        const t = Math.min(1, Math.max(0, (performance.now() - start - delay) / drawMs));
        // Ease-out so the line decelerates as it lands.
        const eased = 1 - Math.pow(1 - t, 3);
        const count = Math.max(2, Math.round(arc.length * eased));
        return arc.slice(0, count);
      }, false);

      const entity = this.viewer.entities.add({
        polyline: {
          positions,
          width: target.kind === 'adversary' ? 2.4 : 1.8,
          material: new PolylineGlowMaterialProperty({
            color: colour.withAlpha(target.kind === 'relation' ? 0.5 : 0.85),
            glowPower: 0.08,
            taperPower: 0.6,
          }),
          clampToGround: false,
        },
      });
      this.lineEntities.push(entity);
    });
  }

  clearLines(): void {
    for (const e of this.lineEntities) this.viewer.entities.remove(e);
    this.lineEntities = [];
  }

  /**
   * Headline pins. Only the loudest stories get one, because a pin per story
   * turns the globe into confetti and costs frames.
   */
  setPins(
    pins: Array<{ iso2: string; centroid: [number, number]; title: string; status: Status; count: number }>,
  ): void {
    this.clearPins();
    for (const pin of pins) {
      const colour =
        pin.status === 'war'
          ? Color.fromCssColorString('#c8372d')
          : pin.status === 'conflict'
            ? Color.fromCssColorString('#b86b2e')
            : pin.status === 'tension'
              ? Color.fromCssColorString('#b9972f')
              : Color.fromCssColorString('#ede8e0');

      const entity = this.viewer.entities.add({
        position: Cartesian3.fromDegrees(pin.centroid[0], pin.centroid[1], 12_000),
        point: {
          // Conflict pins breathe with the shared pulse phase; others hold.
          pixelSize: this.reducedMotion || pin.status === 'peace' || pin.status === 'unknown'
            ? 7
            : new CallbackProperty(() => 6 + 3 * this.pulseAlpha(1), false) as unknown as number,
          color: colour.withAlpha(0.9),
          outlineColor: Color.fromCssColorString('#000000').withAlpha(0.75),
          outlineWidth: 2,
          heightReference: HeightReference.NONE,
          // Pins shrink with distance so a zoomed-out globe stays legible.
          scaleByDistance: new NearFarScalar(1.5e6, 1.4, 2.4e7, 0.55),
          translucencyByDistance: new NearFarScalar(1.5e6, 1, 3.2e7, 0.35),
        },
        label: {
          text: pin.count > 1 ? String(pin.count) : '',
          font: '600 11px Archivo, sans-serif',
          fillColor: Color.fromCssColorString('#000000'),
          style: LabelStyle.FILL,
          verticalOrigin: VerticalOrigin.CENTER,
          pixelOffset: new Cartesian2(0, 0),
          // Counts only appear once the camera is close enough to read them.
          translucencyByDistance: new NearFarScalar(2e6, 1, 1.1e7, 0),
          scaleByDistance: new NearFarScalar(1.5e6, 1, 1.1e7, 0.6),
        },
        properties: { iso2: pin.iso2 },
      });
      this.pinEntities.push(entity);
    }
  }

  clearPins(): void {
    for (const e of this.pinEntities) this.viewer.entities.remove(e);
    this.pinEntities = [];
  }

  destroy(): void {
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}

/**
 * Samples a great-circle arc between two points, bowed outward from the
 * surface so it reads as a connection over the globe. The bow height scales
 * with distance, so neighbours get a shallow hop and antipodes a tall sweep.
 */
function greatCircleArc(
  a: [number, number],
  b: [number, number],
  samples: number,
): Cartesian3[] {
  const start = Cartographic.fromDegrees(a[0], a[1]);
  const end = Cartographic.fromDegrees(b[0], b[1]);

  // Central angle, used for both interpolation and bow height.
  const lat1 = start.latitude;
  const lon1 = start.longitude;
  const lat2 = end.latitude;
  const lon2 = end.longitude;
  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((lat2 - lat1) / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
        ),
      ),
    );

  if (d === 0) return [Cartesian3.fromRadians(lon1, lat1, 0)];

  const peak = Math.min(1_800_000, 240_000 + d * 1_100_000);
  const out: Cartesian3[] = [];

  for (let i = 0; i <= samples; i++) {
    const f = i / samples;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lon = Math.atan2(y, x);
    // Sine bow: zero at both ends, highest in the middle.
    const height = Math.sin(f * Math.PI) * peak;
    out.push(Cartesian3.fromRadians(lon, lat, height, Ellipsoid.WGS84));
  }
  return out;
}
