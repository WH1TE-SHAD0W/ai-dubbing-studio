import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createStore } from '../live'
import { SPEECH_LEVEL, idleMicState, type MicState } from '../live/mic'
import { MicMeter, MicPicker, silentHint } from './MicPicker'

const on: MicState = {
  ...idleMicState,
  status: 'on',
  activeLabel: 'Built-in Mic',
  devices: [
    { id: 'a', label: 'Built-in Mic' },
    { id: 'b', label: 'USB Headset' },
  ],
}

const renderPicker = (mic: Partial<MicState> = {}, extra: { hint?: string; onSelect?: (c: string) => void } = {}) => {
  const level = createStore({ level: 0.3 })
  const onSelect = extra.onSelect ?? vi.fn()
  render(<MicPicker mic={{ ...on, ...mic }} level={level} onSelect={onSelect} hint={extra.hint} />)
  return { level, onSelect }
}

describe('MicPicker', () => {
  it('lists the system default, naming the device it resolved to, then every input', () => {
    renderPicker()
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['System default (Built-in Mic)', 'Built-in Mic', 'USB Headset'])
    expect(screen.getByLabelText('Microphone input')).toHaveValue('')
  })

  it('reports the host’s choice', async () => {
    const { onSelect } = renderPicker()
    await userEvent.selectOptions(screen.getByLabelText('Microphone input'), 'b')
    expect(onSelect).toHaveBeenCalledWith('b')
    await userEvent.selectOptions(screen.getByLabelText('Microphone input'), '')
    expect(onSelect).toHaveBeenLastCalledWith('')
  })

  it('shows a chosen device even before the device list has loaded', () => {
    renderPicker({ choice: 'zz', devices: [], activeLabel: 'Studio Mic' })
    expect(screen.getByLabelText('Microphone input')).toHaveValue('zz')
    expect(screen.getByRole('option', { name: 'Studio Mic' })).toBeInTheDocument()
  })

  it('is disabled while switching and while the microphone is not on', () => {
    const { rerender } = render(<MicPicker mic={{ ...on, switching: true }} level={createStore({ level: 0 })} onSelect={() => {}} />)
    expect(screen.getByLabelText('Microphone input')).toBeDisabled()
    expect(screen.getByText('Switching…')).toBeInTheDocument()
    rerender(<MicPicker mic={{ ...on, status: 'lost' }} level={createStore({ level: 0 })} onSelect={() => {}} />)
    expect(screen.getByLabelText('Microphone input')).toBeDisabled()
  })

  it('offers voice cleanup only when asked to, and reports the host’s choice', async () => {
    renderPicker()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    const onProcessing = vi.fn()
    render(<MicPicker mic={{ ...on, processing: true }} level={createStore({ level: 0 })} onSelect={() => {}} onProcessing={onProcessing} />)
    const box = screen.getByRole('checkbox', { name: /voice cleanup/i })
    expect(box).toBeChecked()
    await userEvent.click(box)
    expect(onProcessing).toHaveBeenCalledWith(false)
  })

  it('shows voice cleanup as off, and locks it while switching', () => {
    const level = createStore({ level: 0 })
    const { rerender } = render(<MicPicker mic={{ ...on, processing: false }} level={level} onSelect={() => {}} onProcessing={() => {}} />)
    expect(screen.getByRole('checkbox', { name: /voice cleanup/i })).not.toBeChecked()
    rerender(<MicPicker mic={{ ...on, processing: false, switching: true }} level={level} onSelect={() => {}} onProcessing={() => {}} />)
    expect(screen.getByRole('checkbox', { name: /voice cleanup/i })).toBeDisabled()
  })

  it('suggests turning voice cleanup off for a silent input, but only while it is on', () => {
    expect(silentHint({ ...on, processing: true })).toMatch(/mixer, virtual cable or video.*turn voice cleanup off/i)
    expect(silentHint({ ...on, processing: false })).not.toMatch(/voice cleanup/i)
    expect(silentHint({ ...on, processing: false })).toMatch(/mute switch/i)
  })

  it('announces notices and hints in a polite live region', () => {
    renderPicker({ notice: 'Microphone disconnected, switched to the system default.' }, { hint: 'We can hear you ✓' })
    const region = screen.getByText(/disconnected, switched/i).closest('[aria-live]')!
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveTextContent('We can hear you ✓')
  })
})

describe('MicMeter', () => {
  it('follows the level store, and marks where speech starts', () => {
    const level = createStore({ level: 0.2 })
    const { container } = render(<MicMeter level={level} />)
    const meter = screen.getByRole('meter', { name: 'Microphone level' })
    expect(meter).toHaveAttribute('aria-valuenow', '20')
    expect(container.querySelector('.meter__fill--hot')).toBeNull() // below the speech threshold

    act(() => level.setState({ level: 0.8 }))
    expect(meter).toHaveAttribute('aria-valuenow', '80')
    expect(container.querySelector('.meter__fill--hot')).not.toBeNull()
    expect((container.querySelector('.meter__mark') as HTMLElement).style.left).toBe(`${SPEECH_LEVEL * 100}%`)
  })
})
