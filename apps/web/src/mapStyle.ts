import type { MapDrawing, Point } from '@offgrid/maps';
import type { GeoJSONSourceSpecification, StyleSpecification } from 'maplibre-gl';

export const emptyFeatures = () => ({ type: 'FeatureCollection' as const, features: [] });
export function routeData(route?: Point[]) {
  return { type: 'FeatureCollection' as const, features: route?.length ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: route } }] : [] };
}

/** All geometry and fonts are local. GeoJSON is tiled/simplified in MapLibre's worker. */
export function offlineStyle(drawing: MapDrawing): StyleSpecification {
  const [w,s,e,n] = drawing.bounds;
  const streets: GeoJSONSourceSpecification = { type: 'geojson', maxzoom: 18, tolerance: 1,
    data: { type: 'FeatureCollection', features: drawing.roads.map(road => ({ type: 'Feature', properties: { kind: road.kind }, geometry: { type: 'LineString', coordinates: road.points } })) } };
  const layers: StyleSpecification['layers'] = [];
  for (const group of ['major','local','walking'] as const) {
    const kinds = group === 'major' ? ['trunk','primary','secondary','tertiary'] : group === 'walking' ? ['footway','path','steps','pedestrian'] : ['residential','unclassified','service','living_street','track','road','motorway'];
    const minzoom = group === 'major' ? 0 : group === 'local' ? 11.5 : 13.5;
    layers.push(
      { id: `${group}-casing`, type: 'line', source: 'streets', minzoom, filter: ['in', ['get','kind'], ['literal',kinds]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fafbf5', 'line-width': ['interpolate',['linear'],['zoom'],10,group === 'major' ? 2.5 : 1,16,group === 'walking' ? 3 : 8,20,group === 'walking' ? 5 : 16] } },
      { id: `${group}-line`, type: 'line', source: 'streets', minzoom, filter: ['in', ['get','kind'], ['literal',kinds]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': group === 'major' ? '#c9bd93' : group === 'walking' ? '#8eaa79' : '#c4ccba', 'line-width': ['interpolate',['linear'],['zoom'],10,group === 'major' ? 1 : .5,16,group === 'walking' ? 1 : 4,20,group === 'walking' ? 2 : 10], ...(group === 'walking' ? { 'line-dasharray': [2,2] } : {}) } },
    );
  }
  return {
    version: 8,
    sources: {
      streets,
      coverage: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] } } },
      places: { type: 'geojson', data: { type: 'FeatureCollection', features: drawing.labels.map(label => ({ type: 'Feature', properties: { name: label.text }, geometry: { type: 'Point', coordinates: label.point } })) } },
      route: { type: 'geojson', data: emptyFeatures() },
      position: { type: 'geojson', data: emptyFeatures() },
    },
    layers: [
      { id: 'ground', type: 'background', paint: { 'background-color': '#ecece2' } },
      { id: 'coverage', type: 'fill', source: 'coverage', paint: { 'fill-color': '#e2e9d9' } },
      ...layers,
      { id: 'boundary', type: 'line', source: 'coverage', paint: { 'line-color': '#41684c', 'line-width': 1.5, 'line-dasharray': [4,3] } },
      { id: 'walking-route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fcfcf8', 'line-width': 9 } },
      { id: 'walking-route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#254e3d', 'line-width': 5 } },
      { id: 'places', type: 'symbol', source: 'places', layout: { 'text-field': ['get','name'], 'text-font': ['DM Sans Variable','Noto Sans Devanagari','sans-serif'], 'text-size': 12, 'text-padding': 8, 'text-max-width': 12 }, paint: { 'text-color': '#50634c', 'text-halo-color': '#eef1e5', 'text-halo-width': 1.5 } },
      { id: 'location-halo', type: 'circle', source: 'position', paint: { 'circle-color': '#456fa5', 'circle-radius': 15, 'circle-opacity': .18 } },
      { id: 'location-dot', type: 'circle', source: 'position', paint: { 'circle-color': '#456fa5', 'circle-radius': 6, 'circle-stroke-color': '#fcfcf8', 'circle-stroke-width': 2 } },
    ],
  };
}
