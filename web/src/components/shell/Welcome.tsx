import { motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { Icon } from '../chat/icons'
import './Welcome.css'

export interface WelcomeProps {
  /** Optional line under the heading. */
  subtitle?: string
  /** Send a hint chip into a fresh chat (the flow App owns while no chat is open). */
  onSuggestion: (text: string) => void | Promise<void>
}

const SUGGESTIONS = [
  '호르몬 주기를 시각화한 인터랙티브 페이지 만들어줘',
  'Compare the top 5 EV batteries and build me a chart',
  'Explain diffusion models with a visual walkthrough',
]

/** Shell-level empty state, shown before a chat is open. */
export function Welcome({ subtitle, onSuggestion }: WelcomeProps) {
  return (
    <div className="rml-welcome">
      <motion.div
        className="rml-welcome__inner"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, ease: EASE }}
      >
        <p className="rml-welcome__eyebrow">Rautml</p>
        <h2 className="rml-welcome__title">What should we look into?</h2>
        <p className="rml-welcome__sub">
          {subtitle ?? 'Ask for anything. It researches first, then builds you something to look at.'}
        </p>

        <ul className="rml-welcome__hints">
          {SUGGESTIONS.map((s, i) => (
            <motion.li
              key={s}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.36, ease: EASE, delay: 0.08 + i * 0.06 }}
            >
              <button type="button" onClick={() => void onSuggestion(s)}>
                <span>{s}</span>
                <Icon name="arrowDown" size={14} className="rml-welcome__hint-arrow" />
              </button>
            </motion.li>
          ))}
        </ul>
      </motion.div>
    </div>
  )
}

export default Welcome
