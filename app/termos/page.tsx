import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Termos de Serviço",
	description: "Termos de Uso do AutoReels",
};

export default function TermosPage() {
	return (
		<div className="min-h-screen bg-ios-background text-ios-text">
			<div className="mx-auto max-w-2xl px-6 py-16">
				<h1 className="text-2xl font-bold mb-2">Termos de Serviço</h1>
				<p className="text-ios-text-secondary text-sm mb-8">
					Última atualização: 1 de setembro de 2026
				</p>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">1. Aceitação dos termos</h2>
					<p className="text-sm leading-relaxed mb-3">
						Ao acessar ou usar o AutoReels (“a plataforma”, “o serviço”, “nós”),
						você concorda com estes Termos de Serviço. Se você não concordar com
						qualquer parte destes termos, não use o serviço.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">2. Descrição do serviço</h2>
					<p className="text-sm leading-relaxed mb-3">
						O AutoReels é uma ferramenta de automação de conteúdo que permite
						agendar e publicar vídeos e publicações em redes sociais como
						Instagram, YouTube e TikTok, a partir de uma biblioteca de conteúdo
						centralizada e planners configuráveis.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">3. Contas e responsabilidade</h2>
					<p className="text-sm leading-relaxed mb-3">
						Você é responsável por manter a confidencialidade das suas credenciais
						e por todas as atividades realizadas na sua conta. Você concorda em
						usar o serviço apenas para finalidades legais, respeitando os termos de
						serviço de cada plataforma de rede social conectada (Instagram, YouTube,
						TikTok e demais), incluindo políticas contra spam, conteúdo enganoso e
						publicação automatizada não autorizada.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">4. Conteúdo publicado</h2>
					<p className="text-sm leading-relaxed mb-3">
						Todo o conteúdo publicado por meio do serviço é de sua inteira
						responsabilidade. Você declara possuir os direitos necessários sobre o
						conteúdo (mídia, textos, produtos afiliados) e que sua publicação não
						viola direitos de terceiros, leis aplicáveis ou políticas das
						plataformas.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">5. Produtos de afiliados</h2>
					<p className="text-sm leading-relaxed mb-3">
						O serviço pode auxiliar na sugestão e organização de produtos de
						afiliados. A aprovação, os valores de comissão e a disponibilidade dos
						produtos são de responsabilidade de cada programa de afiliados e das
						plataformas parceiras. Não garantimos aprovação, conversão ou
						rendimentos.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">6. Limitação de responsabilidade</h2>
					<p className="text-sm leading-relaxed mb-3">
						O serviço é fornecido “no estado em que se encontra”, sem garantias
						expressas ou implícitas. Na máxima extensão permitida por lei, não seremos
						responsáveis por danos indiretos, incidentais ou consequenciais,
						incluindo perda de dados, de receita ou de oportunidades, decorrentes do
						uso ou da impossibilidade de uso do serviço.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">7. Alterações nos termos</h2>
					<p className="text-sm leading-relaxed mb-3">
						Podemos atualizar estes Termos periodicamente. Alterações relevantes
						serão comunicadas por meio do serviço. O uso continuado após a
						atualização constitui aceitação dos novos termos.
					</p>
				</section>

				<section className="mb-6">
					<h2 className="text-lg font-semibold mb-2">8. Contato</h2>
					<p className="text-sm leading-relaxed">
						Para dúvidas sobre estes Termos, entre em contato pelo e-mail de suporte
						disponível na página de configurações do serviço.
					</p>
				</section>
			</div>
		</div>
	);
}