import { createRoot } from 'react-dom/client'
import { App } from './App'

const root = document.getElementById('root')
if (root === null) throw new Error('Builder dashboard root element is missing')
createRoot(root).render(<App />)
