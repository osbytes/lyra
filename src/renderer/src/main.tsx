import './assets/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Overlay } from './components/Overlay'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// The same bundle renders the floating recording pill in its own window.
const isOverlay = window.location.hash === '#overlay'
if (isOverlay) document.documentElement.classList.add('is-overlay')

createRoot(root).render(<StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>)
