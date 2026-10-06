import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { load, save } from '../lib/storage'
import { FakeAudioContext, FakeMediaDevices } from '../test/audioFakes'
import { CreateSessionPage } from './CreateSession'

// jsdom has no Web Audio: the shared AudioContext is replaced by a fake.
const fakeCtx = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../lib/audio', async () => {
  const { FakeAudioContext } = await import('../test/audioFakes')
  const ctx = new FakeAudioContext()
  fakeCtx.current = ctx
  return { getAudioContext: () => ctx.asCtx() }
})

let md: FakeMediaDevices

beforeEach(() => {
  md = new FakeMediaDevices()
  Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true })
  save('ads.host', { name: 'Dr. Test' })
})

afterEach(() => {
  localStorage.clear()
  Reflect.deleteProperty(navigator, 'mediaDevices')
  ;(fakeCtx.current as FakeAudioContext).state = 'running'
})

const renderPage = () =>
  render(
    <MemoryRouter>
      <CreateSessionPage />
    </MemoryRouter>,
  )

describe('Create session: microphone check', () => {
  it('does not touch the microphone until the host asks', () => {
    renderPage()
    expect(md.calls).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Microphone input')).not.toBeInTheDocument()
  })

  it('opens the microphone on tap and shows the picker and a prompt to speak', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(await screen.findByLabelText('Microphone input')).toBeInTheDocument()
    expect(md.calls).toHaveLength(1)
    expect(screen.getByRole('meter', { name: 'Microphone level' })).toBeInTheDocument()
    expect(screen.getByText('Say something to test.')).toBeInTheDocument()
  })

  it('remembers the chosen microphone for the studio', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    await user.selectOptions(await screen.findByLabelText('Microphone input'), 'mic-b')

    await waitFor(() => expect(load<{ deviceId: string }>('ads.mic')?.deviceId).toBe('mic-b'))
    expect(md.liveStreams()).toHaveLength(1)
    expect(md.liveStreams()[0]!.track.deviceId).toBe('mic-b')
  })

  it('releases the microphone when the host stops the test or leaves the screen', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByLabelText('Microphone input')
    expect(md.liveStreams()).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(md.liveStreams()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByLabelText('Microphone input')
    unmount() // navigating on to the studio, which opens the device itself
    expect(md.liveStreams()).toHaveLength(0)
  })

  it('explains a blocked microphone and lets the host try again', async () => {
    md.failures.set('', 'NotAllowedError')
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked/i)
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeEnabled()
  })

  it('never blocks Start: the session needs only a title, a language and the consents', async () => {
    const user = userEvent.setup()
    renderPage()
    const start = screen.getByRole('button', { name: 'Start session' })
    expect(start).toBeDisabled()
    expect(screen.getByText('Add a session title.')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Session title'), 'Ethics 101')
    await user.click(screen.getByRole('button', { name: 'Slovak' }))
    await user.click(screen.getByLabelText('The speaker agrees to have their voice cloned'))
    await user.click(screen.getByLabelText('Listeners are told the audio is AI-generated.'))

    expect(start).toBeEnabled() // without ever testing the microphone
    expect(md.calls).toHaveLength(0)
  })
})
