import { registerRootComponent } from 'expo';
// The background location task must be defined at module load (also in headless starts).
import './src/lib/location';
import App from './src/App';

registerRootComponent(App);
