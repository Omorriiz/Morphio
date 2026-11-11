interface Props {
  emoji: string
  title: string
  text: string
}

export default function ComingSoon({ emoji, title, text }: Props): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="hero-emoji">{emoji}</div>
      <h1>{title}</h1>
      <p>{text}</p>
      <span className="pill">Скоро появится</span>
    </div>
  )
}
